import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalPaymentSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentIngestService } from './payment-ingest.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { QontoClient, QontoTransaction } from './qonto.client';

@Injectable()
export class QontoPollService {
  private readonly logger = new Logger(QontoPollService.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly qonto: QontoClient,
    private readonly ingest: PaymentIngestService,
    private readonly reconciliation: PaymentReconciliationService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<string>('QONTO_ENABLED') === 'true';
  }

  isConfigured(): boolean {
    return this.qonto.isConfigured();
  }

  isRunning(): boolean {
    return this.running;
  }

  async getStatus() {
    const last = await this.prisma.syncJob.findFirst({
      where: { jobType: 'qonto_poll' },
      orderBy: { startedAt: 'desc' },
    });
    return {
      enabled: this.isEnabled(),
      configured: this.isConfigured(),
      inProgress: this.running,
      intervalMinutes: 5,
      last,
    };
  }

  async pollOnce(): Promise<{
    fetched: number;
    ingested: number;
    skippedInternal: number;
    rematchChecked?: number;
    rematchAutoApplied?: number;
  }> {
    if (!this.isEnabled() || !this.qonto.isConfigured()) {
      return { fetched: 0, ingested: 0, skippedInternal: 0 };
    }
    if (this.running) {
      this.logger.warn('Qonto poll already running — skip');
      return { fetched: 0, ingested: 0, skippedInternal: 0 };
    }

    this.running = true;
    const job = await this.prisma.syncJob.create({
      data: {
        jobType: 'qonto_poll',
        status: 'running',
        metadata: { phase: 'fetching' },
      },
    });

    try {
      const lookbackHours = Number(
        this.config.get('QONTO_POLL_LOOKBACK_HOURS') ?? 72,
      );
      const credits = await this.qonto.listRecentCredits(lookbackHours);
      let ingested = 0;
      let skippedInternal = 0;

      for (const tx of credits) {
        if (this.shouldSkip(tx)) {
          skippedInternal += 1;
          continue;
        }
        const normalized = this.ingest.normalizeQontoPayload({
          transaction: tx as unknown as Record<string, unknown>,
        });
        if (!normalized) continue;

        if (tx.transaction_id) {
          normalized.externalId = tx.transaction_id;
        }
        normalized.source = ExternalPaymentSource.QONTO;

        const result = await this.reconciliation.ingestAndReconcile(normalized);
        if (
          result.status === 'AUTO_APPLIED' ||
          result.status === 'PENDING_REVIEW' ||
          result.status === 'MANUALLY_APPLIED' ||
          result.status === 'RECEIVED' ||
          result.status === 'SKIPPED' ||
          result.status === 'FAILED'
        ) {
          ingested += 1;
        }
      }

      const rematch = await this.reconciliation.rematchPendingReview();

      const summary = {
        fetched: credits.length,
        ingested,
        skippedInternal,
        rematchChecked: rematch.checked,
        rematchAutoApplied: rematch.autoApplied,
      };
      this.logger.log(
        `Qonto poll: fetched=${summary.fetched} processed=${summary.ingested} skippedInternal=${summary.skippedInternal} rematchAuto=${summary.rematchAutoApplied}`,
      );
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          finishedAt: new Date(),
          metadata: summary,
        },
      });
      return summary;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Qonto poll failed';
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: message,
        },
      });
      throw error;
    } finally {
      this.running = false;
    }
  }

  private shouldSkip(tx: QontoTransaction): boolean {
    if (tx.side && tx.side !== 'credit') return true;
    if (tx.status && tx.status !== 'completed') return true;
    const reference = `${tx.reference ?? ''} ${tx.label ?? ''}`.toLowerCase();
    if (
      reference.includes('interne ueberweisung') ||
      reference.includes('interne überweisung') ||
      reference.includes('internal transfer')
    ) {
      return true;
    }
    return false;
  }
}

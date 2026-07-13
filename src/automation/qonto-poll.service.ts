import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalPaymentSource } from '@prisma/client';
import { PaymentIngestService } from './payment-ingest.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { QontoClient, QontoTransaction } from './qonto.client';

@Injectable()
export class QontoPollService {
  private readonly logger = new Logger(QontoPollService.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly qonto: QontoClient,
    private readonly ingest: PaymentIngestService,
    private readonly reconciliation: PaymentReconciliationService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<string>('QONTO_ENABLED') === 'true';
  }

  async pollOnce(): Promise<{
    fetched: number;
    ingested: number;
    skippedInternal: number;
  }> {
    if (!this.isEnabled() || !this.qonto.isConfigured()) {
      return { fetched: 0, ingested: 0, skippedInternal: 0 };
    }
    if (this.running) {
      this.logger.warn('Qonto poll already running — skip');
      return { fetched: 0, ingested: 0, skippedInternal: 0 };
    }

    this.running = true;
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

        // Prefer stable transaction_id when present
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

      this.logger.log(
        `Qonto poll: fetched=${credits.length} processed=${ingested} skippedInternal=${skippedInternal}`,
      );
      return { fetched: credits.length, ingested, skippedInternal };
    } finally {
      this.running = false;
    }
  }

  private shouldSkip(tx: QontoTransaction): boolean {
    if (tx.side && tx.side !== 'credit') return true;
    if (tx.status && tx.status !== 'completed') return true;
    const reference = `${tx.reference ?? ''} ${tx.label ?? ''}`.toLowerCase();
    // Explicit internal transfer wording only — Qonto's is_external_transaction
    // flag is not reliable for external guest payments.
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

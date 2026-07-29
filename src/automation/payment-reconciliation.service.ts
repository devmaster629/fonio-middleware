import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ExternalPaymentSource,
  ExternalPaymentStatus,
  PaymentMatchDecision,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  isInquiryReservationStatus,
  NormalizedExternalPayment,
} from './automation.types';
import { PaymentAlertService } from './payment-alert.service';
import { PaymentApplyService } from './payment-apply.service';
import { PaymentMatcherService } from './payment-matcher.service';
import { HostawayClient } from '../hostaway/hostaway.client';

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly matcher: PaymentMatcherService,
    private readonly apply: PaymentApplyService,
    private readonly alerts: PaymentAlertService,
    private readonly hostaway: HostawayClient,
  ) {}

  async ingestAndReconcile(
    payment: NormalizedExternalPayment,
  ): Promise<{ id: string; status: ExternalPaymentStatus }> {
    const existing = await this.prisma.externalPayment.findUnique({
      where: {
        source_externalId: {
          source: payment.source,
          externalId: payment.externalId,
        },
      },
    });
    if (existing) {
      return { id: existing.id, status: existing.status };
    }

    const record = await this.prisma.externalPayment.create({
      data: {
        source: payment.source,
        externalId: payment.externalId,
        amount: payment.amount,
        currency: payment.currency,
        occurredAt: payment.occurredAt,
        payerName: payment.payerName,
        payerEmail: payment.payerEmail,
        reference: payment.reference,
        rawPayload: payment.rawPayload as Prisma.InputJsonValue,
        status: ExternalPaymentStatus.RECEIVED,
      },
    });

    return this.reconcile(record.id);
  }

  async reconcile(
    paymentId: string,
    options?: { allowAutoApply?: boolean },
  ): Promise<{ id: string; status: ExternalPaymentStatus }> {
    const allowAutoApply = options?.allowAutoApply !== false;
    const payment = await this.prisma.externalPayment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    if (
      payment.status === ExternalPaymentStatus.AUTO_APPLIED ||
      payment.status === ExternalPaymentStatus.MANUALLY_APPLIED
    ) {
      return { id: payment.id, status: payment.status };
    }

    const wasNew = payment.status === ExternalPaymentStatus.RECEIVED;

    const normalized: NormalizedExternalPayment = {
      source: payment.source,
      externalId: payment.externalId,
      amount: payment.amount,
      currency: payment.currency,
      occurredAt: payment.occurredAt,
      payerName: payment.payerName ?? undefined,
      payerEmail: payment.payerEmail ?? undefined,
      reference: payment.reference ?? undefined,
      rawPayload: payment.rawPayload as Record<string, unknown>,
    };

    const match = await this.matcher.match(normalized);

    if (
      allowAutoApply &&
      match.decision === PaymentMatchDecision.UNAMBIGUOUS &&
      match.best
    ) {
      try {
        const applied = await this.apply.applyToReservation({
          reservationHostawayId: match.best.hostawayId,
          amount: payment.amount,
          currency: payment.currency,
          source: payment.source,
          reference: payment.reference ?? undefined,
          occurredAt: payment.occurredAt,
          appliedMode: 'automatic',
        });

        const updated = await this.prisma.externalPayment.update({
          where: { id: payment.id },
          data: {
            status: ExternalPaymentStatus.AUTO_APPLIED,
            matchDecision: match.decision,
            matchScore: match.best.score,
            matchReason: match.reason,
            matchCandidates: match.candidates as unknown as Prisma.InputJsonValue,
            matchedReservationId: match.best.reservationId,
            hostawayChargeId: applied.chargeId,
            allocations: {
              create: [
                {
                  reservationId: match.best.reservationId,
                  amount: payment.amount,
                  hostawayChargeId: applied.chargeId,
                  sortOrder: 0,
                },
              ],
            },
          },
        });
        return { id: updated.id, status: updated.status };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Hostaway apply failed';
        const updated = await this.prisma.externalPayment.update({
          where: { id: payment.id },
          data: {
            status: ExternalPaymentStatus.FAILED,
            matchDecision: match.decision,
            matchScore: match.best.score,
            matchReason: match.reason,
            matchCandidates: match.candidates as unknown as Prisma.InputJsonValue,
            matchedReservationId: match.best.reservationId,
            error: message,
          },
        });
        this.logger.error(`Auto-apply failed for payment ${payment.id}: ${message}`);
        return { id: updated.id, status: updated.status };
      }
    }

    const skipDecisions = new Set<PaymentMatchDecision>([
      PaymentMatchDecision.BULK_PAYMENT,
      PaymentMatchDecision.REFUND,
      PaymentMatchDecision.PLATFORM_PAYOUT,
    ]);

    const status = skipDecisions.has(match.decision)
      ? ExternalPaymentStatus.SKIPPED
      : ExternalPaymentStatus.PENDING_REVIEW;

    const updated = await this.prisma.externalPayment.update({
      where: { id: payment.id },
      data: {
        status,
        matchDecision: match.decision,
        matchScore: match.best?.score,
        matchReason: match.reason,
        matchCandidates: match.candidates as unknown as Prisma.InputJsonValue,
        matchedReservationId: match.best?.reservationId,
      },
    });

    if (wasNew && status === ExternalPaymentStatus.PENDING_REVIEW) {
      try {
        await this.alerts.notifyNeedsReview({
          paymentId: updated.id,
          amount: payment.amount,
          currency: payment.currency,
          source: payment.source,
          payerName: payment.payerName,
          reference: payment.reference,
          occurredAt: payment.occurredAt,
          matchReason: match.reason,
          candidates: match.candidates,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'needs-review alert failed';
        this.logger.warn(
          `Needs-review alert failed for payment ${updated.id}: ${message}`,
        );
      }
    }

    return { id: updated.id, status: updated.status };
  }

  /**
   * Re-run matching for payments still in the review queue.
   * Useful after reservation notes/channel sync improve match quality —
   * clear cases can then auto-apply; ambiguous ones stay in review.
   */
  async rematchPendingReview(limit = 40): Promise<{
    checked: number;
    autoApplied: number;
    stillReview: number;
  }> {
    const pending = await this.prisma.externalPayment.findMany({
      where: { status: ExternalPaymentStatus.PENDING_REVIEW },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });

    let autoApplied = 0;
    let stillReview = 0;
    for (const row of pending) {
      const result = await this.reconcile(row.id);
      if (result.status === ExternalPaymentStatus.AUTO_APPLIED) autoApplied += 1;
      else if (result.status === ExternalPaymentStatus.PENDING_REVIEW) stillReview += 1;
    }

    if (pending.length > 0) {
      this.logger.log(
        `Rematch pending review: checked=${pending.length} autoApplied=${autoApplied} stillReview=${stillReview}`,
      );
    }

    return { checked: pending.length, autoApplied, stillReview };
  }

  async confirmReview(
    paymentId: string,
    reviewerEmail: string,
    options: {
      reservationHostawayId?: number;
      note?: string;
      allocations?: Array<{
        reservationHostawayId: number;
        amount: number;
        note?: string;
      }>;
    } = {},
  ) {
    const payment = await this.prisma.externalPayment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== ExternalPaymentStatus.PENDING_REVIEW) {
      throw new NotFoundException('Payment is not in review queue');
    }

    const note = options.note;
    const lines =
      options.allocations && options.allocations.length > 0
        ? options.allocations
        : [
            {
              reservationHostawayId: options.reservationHostawayId,
              amount: payment.amount,
              note,
            },
          ];

    if (lines.length === 1 && !lines[0].reservationHostawayId) {
      // Fall back to previously matched reservation for 1:1 confirm.
      if (!payment.matchedReservationId) {
        throw new NotFoundException('No reservation selected for this payment');
      }
      const matched = await this.prisma.reservation.findUnique({
        where: { id: payment.matchedReservationId },
      });
      if (!matched) throw new NotFoundException('Reservation not found');
      lines[0].reservationHostawayId = matched.hostawayId;
    }

    const normalized = lines.map((line, index) => {
      const reservationHostawayId = Number(line.reservationHostawayId);
      const amount = Number(line.amount);
      if (!Number.isFinite(reservationHostawayId) || reservationHostawayId <= 0) {
        throw new BadRequestException(
          `Allocation #${index + 1}: reservation is required`,
        );
      }
      if (!Number.isFinite(amount) || amount < 0.01) {
        throw new BadRequestException(
          `Allocation #${index + 1}: amount must be at least 0.01`,
        );
      }
      return {
        reservationHostawayId,
        amount: Math.round(amount * 100) / 100,
        note: line.note?.trim() || note,
      };
    });

    const uniqueIds = new Set(
      normalized.map((line) => line.reservationHostawayId),
    );
    if (uniqueIds.size !== normalized.length) {
      throw new BadRequestException(
        'Each split line must use a different reservation',
      );
    }

    const sum = Math.round(
      normalized.reduce((acc, line) => acc + line.amount, 0) * 100,
    ) / 100;
    if (Math.abs(sum - payment.amount) > 0.01) {
      throw new BadRequestException(
        `Split amounts (${sum}) must equal payment amount (${payment.amount})`,
      );
    }

    const reservations = await this.prisma.reservation.findMany({
      where: {
        hostawayId: {
          in: normalized.map((line) => line.reservationHostawayId),
        },
      },
    });
    const byHostawayId = new Map(reservations.map((r) => [r.hostawayId, r]));

    for (const line of normalized) {
      const reservation = byHostawayId.get(line.reservationHostawayId);
      if (!reservation) {
        throw new NotFoundException(
          `Reservation #${line.reservationHostawayId} not found`,
        );
      }
      if (isInquiryReservationStatus(reservation.status)) {
        throw new BadRequestException(
          `Inquiry booking #${line.reservationHostawayId} cannot receive payments`,
        );
      }
    }

    const appliedLines: Array<{
      reservationId: string;
      reservationHostawayId: number;
      amount: number;
      chargeId: number;
      note?: string;
    }> = [];

    try {
      for (const [index, line] of normalized.entries()) {
        const reservation = byHostawayId.get(line.reservationHostawayId)!;
        const applied = await this.apply.applyToReservation({
          reservationHostawayId: reservation.hostawayId,
          amount: line.amount,
          currency: payment.currency,
          source: payment.source,
          reference: payment.reference ?? undefined,
          occurredAt: payment.occurredAt,
          appliedMode: 'manual',
          reviewedBy: reviewerEmail,
          descriptionOverride:
            line.note ||
            (normalized.length > 1
              ? `Teilzahlung ${index + 1}/${normalized.length}`
              : undefined),
        });
        appliedLines.push({
          reservationId: reservation.id,
          reservationHostawayId: reservation.hostawayId,
          amount: line.amount,
          chargeId: applied.chargeId,
          note: line.note,
        });
      }
    } catch (error) {
      // Best-effort rollback of Hostaway charges already created in this split.
      for (const line of appliedLines) {
        try {
          await this.hostaway.cancelGuestCharge(
            line.reservationHostawayId,
            line.chargeId,
          );
        } catch {
          /* ignore */
        }
        await this.prisma.notifiedGuestCharge.deleteMany({
          where: { hostawayChargeId: line.chargeId },
        });
      }
      throw error;
    }

    const primary = appliedLines[0];
    return this.prisma.externalPayment.update({
      where: { id: payment.id },
      data: {
        status: ExternalPaymentStatus.MANUALLY_APPLIED,
        matchedReservationId: primary.reservationId,
        hostawayChargeId: primary.chargeId,
        reviewedBy: reviewerEmail,
        reviewedAt: new Date(),
        reviewNote:
          note ||
          (appliedLines.length > 1
            ? `Split across ${appliedLines.length} bookings`
            : null),
        error: null,
        allocations: {
          create: appliedLines.map((line, index) => ({
            reservationId: line.reservationId,
            amount: line.amount,
            hostawayChargeId: line.chargeId,
            note: line.note,
            sortOrder: index,
          })),
        },
      },
      include: {
        allocations: {
          include: { reservation: { include: { listing: true } } },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
  }

  async skipReview(paymentId: string, reviewerEmail: string, note?: string) {
    const payment = await this.prisma.externalPayment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    return this.prisma.externalPayment.update({
      where: { id: payment.id },
      data: {
        status: ExternalPaymentStatus.SKIPPED,
        reviewedBy: reviewerEmail,
        reviewedAt: new Date(),
        reviewNote: note,
      },
    });
  }

  /**
   * Reverse an incorrect payment assignment:
   * best-effort Hostaway charge cancel + local ledger rollback + return to review queue.
   */
  async undoApplication(paymentId: string, reviewerEmail: string) {
    const payment = await this.prisma.externalPayment.findUnique({
      where: { id: paymentId },
      include: {
        matchedReservation: true,
        allocations: { include: { reservation: true } },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (
      payment.status !== ExternalPaymentStatus.AUTO_APPLIED &&
      payment.status !== ExternalPaymentStatus.MANUALLY_APPLIED
    ) {
      throw new BadRequestException(
        'Only applied payments can be undone',
      );
    }

    const chargeTargets: Array<{
      reservationHostawayId: number;
      hostawayChargeId: number;
    }> = [];

    if (payment.allocations.length > 0) {
      for (const allocation of payment.allocations) {
        if (!allocation.hostawayChargeId) continue;
        chargeTargets.push({
          reservationHostawayId: allocation.reservation.hostawayId,
          hostawayChargeId: allocation.hostawayChargeId,
        });
      }
    } else if (payment.hostawayChargeId && payment.matchedReservation) {
      chargeTargets.push({
        reservationHostawayId: payment.matchedReservation.hostawayId,
        hostawayChargeId: payment.hostawayChargeId,
      });
    }

    const cancelled: number[] = [];
    const failed: number[] = [];
    for (const target of chargeTargets) {
      try {
        await this.hostaway.cancelGuestCharge(
          target.reservationHostawayId,
          target.hostawayChargeId,
        );
        cancelled.push(target.hostawayChargeId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Hostaway cancel failed';
        this.logger.warn(
          `Undo: could not cancel Hostaway charge ${target.hostawayChargeId} on reservation ${target.reservationHostawayId}: ${message}`,
        );
        failed.push(target.hostawayChargeId);
      }
      await this.prisma.notifiedGuestCharge.deleteMany({
        where: { hostawayChargeId: target.hostawayChargeId },
      });
    }

    await this.prisma.paymentAllocation.deleteMany({
      where: { externalPaymentId: payment.id },
    });

    const hostawayChargeCancelled = failed.length === 0 && cancelled.length > 0;
    const noteParts = [
      `Undone by ${reviewerEmail}`,
      cancelled.length
        ? `Hostaway charges cancelled: ${cancelled.join(', ')}`
        : null,
      failed.length
        ? `Hostaway charges may need manual cancel: ${failed.join(', ')}`
        : null,
      payment.reviewNote ? `Previous note: ${payment.reviewNote}` : null,
    ].filter(Boolean);

    await this.prisma.externalPayment.update({
      where: { id: payment.id },
      data: {
        status: ExternalPaymentStatus.PENDING_REVIEW,
        matchedReservationId: null,
        hostawayChargeId: null,
        matchDecision: null,
        matchScore: null,
        matchReason: null,
        matchCandidates: Prisma.JsonNull,
        reviewedBy: reviewerEmail,
        reviewedAt: new Date(),
        reviewNote: noteParts.join(' · '),
        error: failed.length
          ? `Undo incomplete in Hostaway — cancel charge(s) ${failed.join(', ')} manually if still present`
          : null,
      },
    });

    const result = await this.reconcile(payment.id, { allowAutoApply: false });
    return {
      ...result,
      hostawayChargeCancelled,
      hostawayChargeId: payment.hostawayChargeId,
      hostawayChargeIdsCancelled: cancelled,
      hostawayChargeIdsFailed: failed,
      previousReservationHostawayId:
        payment.matchedReservation?.hostawayId ?? null,
    };
  }
}

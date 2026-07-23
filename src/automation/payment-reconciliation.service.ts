import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ExternalPaymentSource,
  ExternalPaymentStatus,
  PaymentMatchDecision,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NormalizedExternalPayment } from './automation.types';
import { PaymentApplyService } from './payment-apply.service';
import { PaymentMatcherService } from './payment-matcher.service';

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly matcher: PaymentMatcherService,
    private readonly apply: PaymentApplyService,
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
  ): Promise<{ id: string; status: ExternalPaymentStatus }> {
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

    if (match.decision === PaymentMatchDecision.UNAMBIGUOUS && match.best) {
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

    return { id: updated.id, status: updated.status };
  }

  async confirmReview(
    paymentId: string,
    reviewerEmail: string,
    reservationHostawayId?: number,
    note?: string,
  ) {
    const payment = await this.prisma.externalPayment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== ExternalPaymentStatus.PENDING_REVIEW) {
      throw new NotFoundException('Payment is not in review queue');
    }

    let reservationId = payment.matchedReservationId;
    if (reservationHostawayId) {
      const reservation = await this.prisma.reservation.findUnique({
        where: { hostawayId: reservationHostawayId },
      });
      if (!reservation) {
        throw new NotFoundException('Reservation not found');
      }
      reservationId = reservation.id;
    }

    if (!reservationId) {
      throw new NotFoundException('No reservation selected for this payment');
    }

    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');

    const applied = await this.apply.applyToReservation({
      reservationHostawayId: reservation.hostawayId,
      amount: payment.amount,
      currency: payment.currency,
      source: payment.source,
      reference: payment.reference ?? undefined,
      occurredAt: payment.occurredAt,
      appliedMode: 'manual',
      reviewedBy: reviewerEmail,
      descriptionOverride: note,
    });

    return this.prisma.externalPayment.update({
      where: { id: payment.id },
      data: {
        status: ExternalPaymentStatus.MANUALLY_APPLIED,
        matchedReservationId: reservation.id,
        hostawayChargeId: applied.chargeId,
        reviewedBy: reviewerEmail,
        reviewedAt: new Date(),
        reviewNote: note,
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
}

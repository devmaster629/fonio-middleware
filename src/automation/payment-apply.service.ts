import { Injectable, Logger } from '@nestjs/common';
import { ExternalPaymentSource } from '@prisma/client';
import { HostawayClient } from '../hostaway/hostaway.client';
import { GuestRequestInboxService } from '../hostaway/guest-request-inbox.service';
import { PaymentInboxService } from '../hostaway/payment-inbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentAlertService } from './payment-alert.service';

@Injectable()
export class PaymentApplyService {
  private readonly logger = new Logger(PaymentApplyService.name);

  constructor(
    private readonly hostaway: HostawayClient,
    private readonly inbox: GuestRequestInboxService,
    private readonly paymentInbox: PaymentInboxService,
    private readonly alerts: PaymentAlertService,
    private readonly prisma: PrismaService,
  ) {}

  async applyToReservation(params: {
    reservationHostawayId: number;
    amount: number;
    currency: string;
    source: ExternalPaymentSource;
    reference?: string;
    occurredAt?: Date;
    appliedMode?: 'automatic' | 'manual';
    reviewedBy?: string;
    /** Optional reviewer note; when set it becomes the Hostaway charge description. */
    descriptionOverride?: string;
  }): Promise<{ chargeId: number; inboxMessageId?: number }> {
    const paymentMethod =
      params.source === ExternalPaymentSource.PAYPAL
        ? 'paypal'
        : 'bank_transfer';

    const reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId: params.reservationHostawayId },
      include: { notifiedCharges: true },
    });
    const total =
      reservation?.totalPrice != null && Number.isFinite(reservation.totalPrice)
        ? reservation.totalPrice
        : null;
    const paid = (reservation?.notifiedCharges ?? []).reduce(
      (sum, charge) => sum + (Number(charge.amount) || 0),
      0,
    );
    const balanceDue =
      total != null ? Math.max(0, Math.round((total - paid) * 100) / 100) : null;
    // Only this payment amount is posted — Hostaway is never marked fully paid
    // unless the amount covers the outstanding balance.
    const isPartial =
      balanceDue != null
        ? params.amount + 0.5 < balanceDue
        : total != null
          ? params.amount + 0.5 < total
          : false;

    const sourceLabel =
      params.source === ExternalPaymentSource.PAYPAL
        ? 'PayPal'
        : params.source === ExternalPaymentSource.QONTO
          ? 'Qonto'
          : 'Zahlung';
    const title = isPartial
      ? `Teilzahlung (${sourceLabel})`
      : params.source === ExternalPaymentSource.PAYPAL
        ? 'PayPal-Zahlung (automatisch)'
        : params.source === ExternalPaymentSource.QONTO
          ? 'Banküberweisung (Qonto, automatisch)'
          : 'Zahlung (automatisch)';

    const charge = await this.hostaway.createOfflineCharge(
      params.reservationHostawayId,
      {
        title,
        description:
          params.descriptionOverride?.slice(0, 500) ||
          params.reference?.slice(0, 500) ||
          (isPartial
            ? 'Teilzahlung — Buchung bleibt teilweise offen'
            : 'Automatisch zugeordnet'),
        amount: params.amount,
        paymentMethod,
        status: 'paid',
        scheduledDate: params.occurredAt
          ?.toISOString()
          .slice(0, 19)
          .replace('T', ' '),
      },
    );

    const paymentMethodLabel =
      params.source === ExternalPaymentSource.PAYPAL ? 'PayPal' : 'Überweisung';
    const inboxResult = await this.inbox.notifyPaymentReceived({
      reservationHostawayId: params.reservationHostawayId,
      amount: params.amount,
      currency: params.currency,
      occurredAt: params.occurredAt,
      paymentMethodLabel,
      source: 'hostaway',
    });

    await this.paymentInbox.recordNotifiedCharge({
      reservationHostawayId: params.reservationHostawayId,
      hostawayChargeId: charge.id,
      amount: params.amount,
      currency: params.currency,
      inboxPosted: inboxResult.posted,
      hostawayMessageId: inboxResult.messageId,
    });

    this.logger.log(
      `Applied ${isPartial ? 'partial' : 'full'} external payment to reservation ${params.reservationHostawayId} (charge ${charge.id})`,
    );

    await this.alerts.notifyApplied({
      reservationHostawayId: params.reservationHostawayId,
      amount: params.amount,
      currency: params.currency,
      source: params.source,
      reference: params.reference,
      occurredAt: params.occurredAt,
      appliedMode: params.appliedMode ?? 'automatic',
      reviewedBy: params.reviewedBy,
      chargeId: charge.id,
    });

    return {
      chargeId: charge.id,
      inboxMessageId: inboxResult.messageId,
    };
  }
}

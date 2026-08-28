import { Injectable, Logger } from '@nestjs/common';
import { LogLevel } from '@prisma/client';
import { GuestRequestInboxService } from '../hostaway/guest-request-inbox.service';
import { HostawayClient } from '../hostaway/hostaway.client';
import { HostawayMessagingService } from '../hostaway/hostaway-messaging.service';
import { AuditLogService } from '../logging/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  berlinDaysSince,
  depositAmount,
  evaluateGuestPaymentSchedule,
  fullAmount,
  type PaymentPhase,
} from './guest-payment-schedule.util';
import { PortalPaymentRulesService } from './portal-payment-rules.service';
import {
  matchPortalRule,
  type PortalPaymentRuleLike,
} from './portal-payment-rules.util';
import { PAYMENT_EXCLUDED_RESERVATION_STATUSES } from './automation.types';

export type GuestPaymentRequestResult = {
  ok: boolean;
  chargeId?: number;
  messageSent?: boolean;
  guestPortalUrl?: string;
  deadlineAt?: Date;
  reason?: string;
};

@Injectable()
export class GuestPaymentAutomationService {
  private readonly logger = new Logger(GuestPaymentAutomationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hostaway: HostawayClient,
    private readonly inbox: GuestRequestInboxService,
    private readonly messaging: HostawayMessagingService,
    private readonly portalRules: PortalPaymentRulesService,
    private readonly audit: AuditLogService,
  ) {}

  /** After CHECK24 (or other) import — send first guest payment request. */
  async requestPaymentOnImport(
    reservationHostawayId: number,
    hints?: { hostNote?: string | null; guestEmail?: string | null },
  ): Promise<GuestPaymentRequestResult> {
    const rules = await this.portalRules.list();
    const rule = matchPortalRule(null, rules, hints);
    if (!rule?.enabled || !rule.autoRequestOnImport) {
      return { ok: false, reason: 'import_request_not_enabled' };
    }

    const reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId: reservationHostawayId },
      include: { notifiedCharges: true },
    });
    if (!reservation || reservation.guestPaymentRequestSentAt) {
      return { ok: false, reason: 'already_requested_or_missing' };
    }

    const isPaid = await this.refreshIsPaid(reservationHostawayId, reservation.isPaid);
    if (isPaid) return { ok: false, reason: 'already_paid' };

    const total = Number(reservation.totalPrice) || 0;
    const matchedPaid = reservation.notifiedCharges.reduce(
      (sum, c) => sum + (Number(c.amount) || 0),
      0,
    );
    const amount = fullAmount(total, rule);
    if (amount <= 1) return { ok: false, reason: 'nothing_due' };

    return this.sendGuestPaymentRequest({
      reservationId: reservation.id,
      reservationHostawayId,
      rule,
      amount,
      phase: 'full',
      deadlineDays: rule.paymentDeadlineDays ?? 7,
    });
  }

  /** Daily job: direct deposit/balance requests, guest reminders, auto-cancel. */
  async processScheduledPayments(): Promise<{
    checked: number;
    requested: number;
    reminded: number;
    canceled: number;
  }> {
    const rules = await this.portalRules.list();
    const candidates = await this.prisma.reservation.findMany({
      where: {
        status: { notIn: [...PAYMENT_EXCLUDED_RESERVATION_STATUSES] },
        autoCanceledAt: null,
        totalPrice: { gt: 0 },
        OR: [
          { guestPaymentRequestSentAt: { not: null } },
          { bookedAt: { not: null } },
        ],
      },
      include: { notifiedCharges: true, listing: true },
      take: 500,
      orderBy: { arrivalDate: 'asc' },
    });

    let requested = 0;
    let reminded = 0;
    let canceled = 0;

    for (const reservation of candidates) {
      const rule = matchPortalRule(reservation.channelName, rules, {
        hostNote: reservation.hostNote,
        guestEmail: reservation.guestEmail,
      });
      if (!rule?.enabled) continue;

      const isPaid = await this.refreshIsPaid(
        reservation.hostawayId,
        reservation.isPaid,
      );
      if (isPaid) continue;

      const total = Number(reservation.totalPrice) || 0;
      const matchedPaid = reservation.notifiedCharges.reduce(
        (sum, c) => sum + (Number(c.amount) || 0),
        0,
      );

      if (
        rule.depositDuePercent != null &&
        rule.depositDuePercent > 0 &&
        reservation.paymentPhase === 'deposit' &&
        reservation.guestPaymentRequestSentAt
      ) {
        const dep = depositAmount(total, rule);
        if (matchedPaid + 0.5 >= dep) {
          await this.prisma.reservation.update({
            where: { id: reservation.id },
            data: {
              paymentPhase: 'deposit_paid',
              guestPaymentRequestSentAt: null,
              guestPaymentReminderSentAt: null,
              paymentDeadlineAt: null,
              pendingPaymentChargeId: null,
            },
          });
          reservation.paymentPhase = 'deposit_paid';
          reservation.guestPaymentRequestSentAt = null;
          reservation.guestPaymentReminderSentAt = null;
          reservation.paymentDeadlineAt = null;
        }
      }

      const daysUntilArrival = berlinDaysUntil(reservation.arrivalDate);
      const daysSinceBooking = berlinDaysSince(
        reservation.bookedAt ?? reservation.createdAt,
      );

      const schedule = evaluateGuestPaymentSchedule({
        rule,
        totalPrice: total,
        matchedPaid,
        isPaid,
        daysUntilArrival,
        daysSinceBooking,
        reservation,
      });

      if (schedule.shouldCancel) {
        const didCancel = await this.cancelUnpaidReservation(
          reservation.id,
          reservation.hostawayId,
          schedule.reason,
        );
        if (didCancel) canceled += 1;
        continue;
      }

      if (schedule.shouldSendGuestReminder) {
        const didRemind = await this.sendGuestPaymentReminder({
          reservation,
          rule,
          amount: schedule.amountDue,
          phase: schedule.phase,
        });
        if (didRemind) reminded += 1;
        continue;
      }

      if (schedule.shouldRequestPayment && rule.autoSendGuestPaymentLink) {
        const deadlineDays =
          schedule.phase === 'deposit'
            ? rule.depositDueDaysAfterBooking ?? 7
            : rule.paymentDeadlineDays ?? null;
        const result = await this.sendGuestPaymentRequest({
          reservationId: reservation.id,
          reservationHostawayId: reservation.hostawayId,
          rule,
          amount: schedule.amountDue,
          phase: schedule.phase,
          deadlineDays: deadlineDays ?? undefined,
          resetReminder: schedule.phase === 'balance',
        });
        if (result.ok) requested += 1;
      }
    }

    return { checked: candidates.length, requested, reminded, canceled };
  }

  private async sendGuestPaymentRequest(params: {
    reservationId: string;
    reservationHostawayId: number;
    rule: PortalPaymentRuleLike;
    amount: number;
    phase: PaymentPhase;
    deadlineDays?: number;
    resetReminder?: boolean;
  }): Promise<GuestPaymentRequestResult> {
    if (!params.rule.autoSendGuestPaymentLink) {
      return { ok: false, reason: 'guest_link_disabled' };
    }

    let chargeId: number | undefined;
    try {
      const title =
        params.phase === 'deposit'
          ? 'Anzahlung'
          : params.phase === 'balance'
            ? 'Restzahlung'
            : 'Zahlung fällig';
      const charge = await this.hostaway.createDueCharge(
        params.reservationHostawayId,
        {
          title,
          description: `Automatische Zahlungsaufforderung (${params.rule.displayName})`,
          amount: params.amount,
        },
      );
      chargeId = charge.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Due charge failed for reservation ${params.reservationHostawayId}: ${message}`,
      );
      await this.audit.log({
        level: LogLevel.ERROR,
        source: 'guest_payment',
        action: 'due_charge_failed',
        metadata: {
          reservationHostawayId: params.reservationHostawayId,
          amount: params.amount,
          error: message,
        },
      });
      return { ok: false, reason: 'charge_failed' };
    }

    let guestPortalUrl: string | undefined;
    try {
      const remote = await this.hostaway.getReservation(params.reservationHostawayId);
      guestPortalUrl = remote.guestPortalUrl?.trim() || undefined;
    } catch {
      /* best effort */
    }

    const deadlineAt =
      params.deadlineDays != null && params.deadlineDays > 0
        ? new Date(Date.now() + params.deadlineDays * 86_400_000)
        : null;

    let messageSent = false;
    if (guestPortalUrl) {
      const inbox = await this.inbox.postInboxMessage(
        params.reservationHostawayId,
        (conversationId) =>
          this.messaging.sendGuestPaymentRequestToGuest({
            conversationId,
            amount: params.amount,
            guestPortalUrl,
            deadlineAt,
            phaseLabel:
              params.phase === 'deposit'
                ? 'Anzahlung'
                : params.phase === 'balance'
                  ? 'Restzahlung'
                  : undefined,
          }),
      );
      messageSent = inbox.posted;
    }

    await this.prisma.reservation.update({
      where: { id: params.reservationId },
      data: {
        guestPaymentRequestSentAt: new Date(),
        ...(params.resetReminder ? { guestPaymentReminderSentAt: null } : {}),
        paymentDeadlineAt: deadlineAt,
        pendingPaymentChargeId: chargeId ?? null,
        paymentPhase: params.phase,
      },
    });

    await this.audit.log({
      level: LogLevel.INFO,
      source: 'guest_payment',
      action: 'payment_request_sent',
      metadata: {
        reservationHostawayId: params.reservationHostawayId,
        amount: params.amount,
        phase: params.phase,
        chargeId,
        messageSent,
        guestPortalUrl: guestPortalUrl ?? null,
        deadlineAt: deadlineAt?.toISOString() ?? null,
        portalKey: params.rule.portalKey,
      },
    });

    return {
      ok: true,
      chargeId,
      messageSent,
      guestPortalUrl,
      deadlineAt: deadlineAt ?? undefined,
    };
  }

  private async sendGuestPaymentReminder(params: {
    reservation: {
      id: string;
      hostawayId: number;
      paymentDeadlineAt: Date | null;
    };
    rule: PortalPaymentRuleLike;
    amount: number;
    phase: PaymentPhase;
  }): Promise<boolean> {
    let guestPortalUrl: string | undefined;
    try {
      const remote = await this.hostaway.getReservation(params.reservation.hostawayId);
      guestPortalUrl = remote.guestPortalUrl?.trim() || undefined;
    } catch {
      return false;
    }
    if (!guestPortalUrl) return false;

    const inbox = await this.inbox.postInboxMessage(
      params.reservation.hostawayId,
      (conversationId) =>
        this.messaging.sendGuestPaymentRequestToGuest({
          conversationId,
          amount: params.amount,
          guestPortalUrl,
          deadlineAt: params.reservation.paymentDeadlineAt,
          isReminder: true,
          phaseLabel:
            params.phase === 'deposit'
              ? 'Anzahlung'
              : params.phase === 'balance'
                ? 'Restzahlung'
                : undefined,
        }),
    );

    if (!inbox.posted) return false;

    await this.prisma.reservation.update({
      where: { id: params.reservation.id },
      data: { guestPaymentReminderSentAt: new Date() },
    });

    await this.audit.log({
      level: LogLevel.INFO,
      source: 'guest_payment',
      action: 'payment_reminder_sent',
      metadata: {
        reservationHostawayId: params.reservation.hostawayId,
        amount: params.amount,
        phase: params.phase,
        portalKey: params.rule.portalKey,
      },
    });

    return true;
  }

  private async cancelUnpaidReservation(
    reservationId: string,
    hostawayId: number,
    reason: string,
  ): Promise<boolean> {
    try {
      await this.hostaway.cancelReservation(hostawayId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Auto-cancel failed for reservation ${hostawayId}: ${message}`,
      );
      await this.audit.log({
        level: LogLevel.ERROR,
        source: 'guest_payment',
        action: 'auto_cancel_failed',
        metadata: { reservationHostawayId: hostawayId, reason, error: message },
      });
      return false;
    }

    await this.prisma.reservation.update({
      where: { id: reservationId },
      data: { autoCanceledAt: new Date(), status: 'cancelled' },
    });

    await this.audit.log({
      level: LogLevel.INFO,
      source: 'guest_payment',
      action: 'auto_canceled',
      metadata: { reservationHostawayId: hostawayId, reason },
    });

    return true;
  }

  private async refreshIsPaid(
    hostawayId: number,
    localIsPaid: boolean | null | undefined,
  ): Promise<boolean> {
    if (localIsPaid === true) return true;
    try {
      const remote = await this.hostaway.getReservation(hostawayId);
      const remotePaid = remote.isPaid === true || remote.isPaid === 1;
      if (remotePaid !== Boolean(localIsPaid)) {
        await this.prisma.reservation.update({
          where: { hostawayId },
          data: { isPaid: remotePaid },
        });
      }
      return remotePaid;
    } catch {
      return false;
    }
  }
}

function berlinDaysUntil(arrivalDate: Date): number {
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const arrivalYmd = arrivalDate.toISOString().slice(0, 10);
  const today = Date.parse(`${todayYmd}T00:00:00.000Z`);
  const arrival = Date.parse(`${arrivalYmd}T00:00:00.000Z`);
  return Math.round((arrival - today) / 86_400_000);
}

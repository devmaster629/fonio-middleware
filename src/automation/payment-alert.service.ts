import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalPaymentSource, LogLevel } from '@prisma/client';
import { GuestRequestInboxService } from '../hostaway/guest-request-inbox.service';
import { HostawayClient } from '../hostaway/hostaway.client';
import { AuditLogService } from '../logging/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PaymentMatchCandidate } from './automation.types';
import {
  buildAppliedEmail,
  buildNeedsReviewEmail,
  buildReviewDigestEmail,
  buildUnpaidReminderEmail,
} from './payment-alert-email.util';
import {
  PAYMENT_EXCLUDED_RESERVATION_STATUSES,
} from './automation.types';
import { PortalPaymentRulesService } from './portal-payment-rules.service';
import { evaluatePortalBalance, matchPortalRule } from './portal-payment-rules.util';

/** How far ahead (days) we scan arrivals for portal-aware unpaid / payment-request jobs. */
const PORTAL_PAYMENT_LOOKAHEAD_DAYS = 40;

@Injectable()
export class PaymentAlertService {
  private readonly logger = new Logger(PaymentAlertService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly portalRules: PortalPaymentRulesService,
    private readonly hostaway: HostawayClient,
    private readonly inbox: GuestRequestInboxService,
  ) {}

  private isEnabled(): boolean {
    return this.config.get<string>('PAYMENT_ALERTS_ENABLED') === 'true';
  }

  private dashboardPaymentsUrl(): string {
    const base = (
      this.config.get<string>('APP_URL') ||
      this.config.get<string>('PRODUCTION_URL') ||
      'https://vermietung.brainions.digital'
    ).replace(/\/$/, '');
    return `${base}/admin?tab=payments`;
  }

  private async getMailConfig(): Promise<{
    host: string;
    port: number;
    user?: string;
    pass?: string;
    from: string;
    to: string;
    secure: boolean;
  } | null> {
    if (!this.isEnabled()) return null;
    const host = this.config.get<string>('PAYMENT_ALERT_SMTP_HOST');
    const from = this.config.get<string>('PAYMENT_ALERT_FROM');
    const to = this.config.get<string>('PAYMENT_ALERT_TO');
    if (!host || !from || !to) {
      this.logger.warn(
        'Payment alerts enabled but SMTP host/from/to are incomplete; skipping email',
      );
      return null;
    }
    return {
      host,
      port: Number(this.config.get<string>('PAYMENT_ALERT_SMTP_PORT') ?? 587),
      user: this.config.get<string>('PAYMENT_ALERT_SMTP_USER') || undefined,
      pass: this.config.get<string>('PAYMENT_ALERT_SMTP_PASS') || undefined,
      from,
      to,
      secure: this.config.get<string>('PAYMENT_ALERT_SMTP_SECURE') === 'true',
    };
  }

  private async sendMail(params: {
    subject: string;
    text: string;
    html?: string;
    correlationId: string;
    action: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const mail = await this.getMailConfig();
    if (!mail) {
      await this.audit.log({
        level: LogLevel.WARN,
        source: 'payment_alert',
        action: 'email_skipped_incomplete_config',
        metadata: {
          correlationId: params.correlationId,
          intendedAction: params.action,
          ...(params.metadata ?? {}),
        },
      });
      return;
    }

    const { default: nodemailer } = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: mail.user && mail.pass ? { user: mail.user, pass: mail.pass } : undefined,
    });

    try {
      const info = await transporter.sendMail({
        from: mail.from,
        to: mail.to,
        subject: params.subject,
        text: params.text,
        html: params.html,
        headers: { 'X-Correlation-Id': params.correlationId },
      });
      const accepted = Array.isArray(info.accepted) ? info.accepted : [];
      const rejected = Array.isArray(info.rejected) ? info.rejected : [];
      this.logger.log(
        `Payment alert (${params.action}) sent messageId=${info.messageId ?? 'n/a'} correlationId=${params.correlationId}`,
      );
      await this.audit.log({
        level: LogLevel.INFO,
        source: 'payment_alert',
        action: 'email_sent',
        metadata: {
          correlationId: params.correlationId,
          alertType: params.action,
          to: mail.to,
          from: mail.from,
          subject: params.subject,
          messageId: info.messageId ?? null,
          accepted,
          rejected,
          response: info.response ?? null,
          ...(params.metadata ?? {}),
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown payment alert error';
      this.logger.error(
        `Payment alert (${params.action}) failed: ${message} correlationId=${params.correlationId}`,
      );
      await this.audit.log({
        level: LogLevel.ERROR,
        source: 'payment_alert',
        action: 'email_failed',
        metadata: {
          correlationId: params.correlationId,
          alertType: params.action,
          to: mail.to,
          from: mail.from,
          subject: params.subject,
          error: message,
          ...(params.metadata ?? {}),
        },
      });
    }
  }

  async notifyApplied(params: {
    reservationHostawayId: number;
    amount: number;
    currency: string;
    source: ExternalPaymentSource;
    reference?: string;
    occurredAt?: Date;
    appliedMode: 'automatic' | 'manual';
    reviewedBy?: string;
    chargeId: number;
  }): Promise<void> {
    if (!this.isEnabled()) return;

    const reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId: params.reservationHostawayId },
      include: { listing: true },
    });

    const correlationId = `pay-alert-${params.chargeId}-${Date.now()}`;
    const email = buildAppliedEmail({
      reservationHostawayId: params.reservationHostawayId,
      amount: params.amount,
      currency: params.currency,
      source: params.source,
      reference: params.reference,
      occurredAt: params.occurredAt,
      appliedMode: params.appliedMode,
      reviewedBy: params.reviewedBy,
      chargeId: params.chargeId,
      guestName: reservation?.guestName,
      listingName: reservation?.listing?.name,
      dashboardUrl: this.dashboardPaymentsUrl(),
      correlationId,
    });

    await this.sendMail({
      subject: email.subject,
      text: email.text,
      html: email.html,
      correlationId,
      action: 'applied',
      metadata: {
        reservationHostawayId: params.reservationHostawayId,
        chargeId: params.chargeId,
        appliedMode: params.appliedMode,
      },
    });
  }

  /** Immediate email when a new payment cannot be auto-matched. */
  async notifyNeedsReview(params: {
    paymentId: string;
    amount: number;
    currency: string;
    source: ExternalPaymentSource;
    payerName?: string | null;
    reference?: string | null;
    occurredAt?: Date | null;
    matchReason?: string | null;
    candidates?: PaymentMatchCandidate[];
  }): Promise<void> {
    if (!this.isEnabled()) return;

    const correlationId = `pay-review-${params.paymentId}-${Date.now()}`;
    const email = buildNeedsReviewEmail({
      amount: params.amount,
      currency: params.currency,
      source: params.source,
      payerName: params.payerName,
      reference: params.reference,
      occurredAt: params.occurredAt,
      matchReason: params.matchReason,
      candidates: params.candidates,
      dashboardUrl: this.dashboardPaymentsUrl(),
      correlationId,
    });

    await this.sendMail({
      subject: email.subject,
      text: email.text,
      html: email.html,
      correlationId,
      action: 'needs_review',
      metadata: {
        paymentId: params.paymentId,
        amount: params.amount,
        candidateCount: params.candidates?.length ?? 0,
      },
    });
  }

  /**
   * Digest for unmatched payments in the review queue.
   * Used by the 19:00 / 08:00 Europe/Berlin reminder schedule.
   */
  async notifyReviewQueueDigest(slot: 'evening' | 'morning'): Promise<{
    sent: boolean;
    count: number;
  }> {
    if (!this.isEnabled()) return { sent: false, count: 0 };

    const count = await this.prisma.externalPayment.count({
      where: { status: 'PENDING_REVIEW' },
    });
    if (count === 0) return { sent: false, count: 0 };

    const samples = await this.prisma.externalPayment.findMany({
      where: { status: 'PENDING_REVIEW' },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        amount: true,
        currency: true,
        source: true,
        payerName: true,
        reference: true,
        createdAt: true,
      },
    });

    const correlationId = `pay-digest-${slot}-${Date.now()}`;
    const email = buildReviewDigestEmail({
      slot,
      count,
      samples,
      dashboardUrl: this.dashboardPaymentsUrl(),
      correlationId,
    });

    await this.sendMail({
      subject: email.subject,
      text: email.text,
      html: email.html,
      correlationId,
      action: 'review_digest',
      metadata: { slot, count },
    });
    return { sent: true, count };
  }

  /**
   * Daily job: portal-aware unpaid office reminders + optional Hostaway inbox
   * payment requests. Respects Hostaway Fully Paid (`isPaid`) and Admin portal rules.
   */
  async notifyUnpaidBeforeArrival(): Promise<{
    checked: number;
    sent: number;
    inboxRequested: number;
  }> {
    if (!this.isEnabled()) {
      return { checked: 0, sent: 0, inboxRequested: 0 };
    }

    const todayYmd = berlinYmdPlusDays(0);
    const endYmd = berlinYmdPlusDays(PORTAL_PAYMENT_LOOKAHEAD_DAYS);
    const dayStart = new Date(`${todayYmd}T00:00:00.000Z`);
    const dayEnd = new Date(`${endYmd}T23:59:59.999Z`);

    const candidates = await this.prisma.reservation.findMany({
      where: {
        arrivalDate: { gte: dayStart, lte: dayEnd },
        totalPrice: { gt: 0 },
        status: { notIn: [...PAYMENT_EXCLUDED_RESERVATION_STATUSES] },
        OR: [
          { unpaidReminderSentAt: null },
          { paymentRequestSentAt: null },
        ],
      },
      include: {
        listing: true,
        notifiedCharges: true,
      },
      take: 400,
      orderBy: { arrivalDate: 'asc' },
    });

    let sent = 0;
    let inboxRequested = 0;
    const portalRulesList = await this.portalRules.list();

    for (const reservation of candidates) {
      const daysUntilArrival = berlinDaysUntil(reservation.arrivalDate);
      if (daysUntilArrival < 0) continue;

      let isPaid = reservation.isPaid === true;
      const matchedPaid = reservation.notifiedCharges.reduce(
        (sum, charge) => sum + (Number(charge.amount) || 0),
        0,
      );
      const total = Number(reservation.totalPrice) || 0;

      const rule = matchPortalRule(reservation.channelName, portalRulesList, {
        hostNote: reservation.hostNote,
        guestEmail: reservation.guestEmail,
      });
      if (!rule) continue;

      // Always refresh Hostaway Fully Paid before evaluating outstanding balance.
      try {
        const remote = await this.hostaway.getReservation(reservation.hostawayId);
        const remotePaid = remote.isPaid === true || remote.isPaid === 1;
        if (remotePaid !== (reservation.isPaid === true)) {
          await this.prisma.reservation.update({
            where: { id: reservation.id },
            data: { isPaid: remotePaid },
          });
        }
        isPaid = remotePaid;
      } catch (err) {
        this.logger.warn(
          `Could not refresh isPaid for reservation ${reservation.hostawayId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }

      if (isPaid) continue;

      // Cheap pre-check before hitting Hostaway for isPaid
      const preliminary = evaluatePortalBalance({
        totalPrice: total,
        matchedPaid,
        isPaid,
        daysUntilArrival,
        rule,
      });
      const mayAct =
        preliminary.shouldOfficeRemind || preliminary.shouldRequestInbox;
      if (!mayAct) continue;

      const evaluation = evaluatePortalBalance({
        totalPrice: total,
        matchedPaid,
        isPaid,
        daysUntilArrival,
        rule,
      });

      if (
        evaluation.shouldRequestInbox &&
        !reservation.paymentRequestSentAt &&
        evaluation.outstanding > 1
      ) {
        const inboxResult = await this.inbox.requestOutstandingPayment({
          reservationHostawayId: reservation.hostawayId,
          amount: evaluation.outstanding,
          currency: 'EUR',
          portalName: evaluation.displayName,
          dueByDaysBeforeArrival: rule.hostDueByDaysBeforeArrival,
          paymentDeadlineDays: rule.overdueGraceDays,
        });
        await this.prisma.reservation.update({
          where: { id: reservation.id },
          data: { paymentRequestSentAt: new Date() },
        });
        if (inboxResult.posted) inboxRequested += 1;
        await this.audit.log({
          level: LogLevel.INFO,
          source: 'payment_alert',
          action: 'portal_payment_request',
          metadata: {
            reservationHostawayId: reservation.hostawayId,
            portalKey: evaluation.portalKey,
            outstanding: evaluation.outstanding,
            posted: inboxResult.posted,
            inboxPending: inboxResult.inboxPending,
          },
        });
      }

      if (
        !evaluation.shouldOfficeRemind ||
        reservation.unpaidReminderSentAt ||
        evaluation.outstanding <= 1
      ) {
        continue;
      }

      const paidForEmail = Math.max(0, total - evaluation.outstanding);
      const hostawayUrl = `https://dashboard.hostaway.com/reservations/${reservation.hostawayId}`;
      const correlationId = `pay-unpaid-${reservation.hostawayId}-${Date.now()}`;
      const email = buildUnpaidReminderEmail({
        reservationHostawayId: reservation.hostawayId,
        guestName: reservation.guestName,
        listingName: reservation.listing?.name,
        channelName: reservation.channelName,
        arrivalDate: reservation.arrivalDate,
        departureDate: reservation.departureDate,
        totalPrice: total,
        paidAmount: paidForEmail,
        balanceDue: evaluation.outstanding,
        currency: 'EUR',
        hostawayUrl,
        dashboardUrl: this.dashboardPaymentsUrl(),
        correlationId,
      });

      await this.sendMail({
        subject: email.subject,
        text: email.text,
        html: email.html,
        correlationId,
        action: 'unpaid_before_arrival',
        metadata: {
          reservationHostawayId: reservation.hostawayId,
          balanceDue: evaluation.outstanding,
          daysUntilArrival,
          portalKey: evaluation.portalKey,
          reason: evaluation.reason,
        },
      });

      await this.prisma.reservation.update({
        where: { id: reservation.id },
        data: { unpaidReminderSentAt: new Date() },
      });
      sent += 1;
    }

    return { checked: candidates.length, sent, inboxRequested };
  }
}

function berlinYmdPlusDays(days: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === 'year')?.value);
  const m = Number(parts.find((p) => p.type === 'month')?.value);
  const d = Number(parts.find((p) => p.type === 'day')?.value);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Whole calendar days from today (Berlin) until arrival date (UTC date column). */
function berlinDaysUntil(arrivalDate: Date): number {
  const todayYmd = berlinYmdPlusDays(0);
  const arrivalYmd = arrivalDate.toISOString().slice(0, 10);
  const today = Date.parse(`${todayYmd}T00:00:00.000Z`);
  const arrival = Date.parse(`${arrivalYmd}T00:00:00.000Z`);
  return Math.round((arrival - today) / 86_400_000);
}

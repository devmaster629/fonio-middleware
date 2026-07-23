import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalPaymentSource, LogLevel } from '@prisma/client';
import { AuditLogService } from '../logging/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentAlertService {
  private readonly logger = new Logger(PaymentAlertService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
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

    const amountLabel = new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: params.currency,
    }).format(params.amount);
    const sourceLabel =
      params.source === ExternalPaymentSource.PAYPAL
        ? 'PayPal'
        : params.source === ExternalPaymentSource.QONTO
          ? 'Qonto / Bank transfer'
          : params.source;
    const subject = `[Hostaway Payments] ${params.appliedMode === 'automatic' ? 'Auto-applied' : 'Applied'} ${amountLabel} for reservation #${params.reservationHostawayId}`;
    const correlationId = `pay-alert-${params.chargeId}-${Date.now()}`;

    const lines = [
      `A payment was ${params.appliedMode === 'automatic' ? 'auto-applied' : 'applied'} in Hostaway.`,
      '',
      `Reservation: #${params.reservationHostawayId}`,
      reservation?.listing?.name ? `Listing: ${reservation.listing.name}` : '',
      reservation?.guestName ? `Guest: ${reservation.guestName}` : '',
      `Amount: ${amountLabel}`,
      `Source: ${sourceLabel}`,
      params.occurredAt ? `Received at: ${params.occurredAt.toISOString()}` : '',
      `Hostaway charge ID: ${params.chargeId}`,
      params.reference ? `Reference: ${params.reference}` : '',
      params.reviewedBy ? `Reviewed by: ${params.reviewedBy}` : '',
      `Dashboard: ${this.dashboardPaymentsUrl()}`,
      `Correlation ID: ${correlationId}`,
      '',
      'This notification was sent by the middleware because Hostaway does not reliably email for API-created offline paid charges.',
    ].filter(Boolean);

    await this.sendMail({
      subject,
      text: lines.join('\n'),
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
  }): Promise<void> {
    if (!this.isEnabled()) return;

    const amountLabel = new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: params.currency,
    }).format(params.amount);
    const sourceLabel =
      params.source === ExternalPaymentSource.PAYPAL
        ? 'PayPal'
        : params.source === ExternalPaymentSource.QONTO
          ? 'Qonto / Bank transfer'
          : String(params.source);
    const subject =
      'A payment has been received and is waiting for assignment.';
    const correlationId = `pay-review-${params.paymentId}-${Date.now()}`;
    const link = this.dashboardPaymentsUrl();

    const lines = [
      'A payment was received but could not be matched automatically.',
      'Please open the payment matching section and assign it to the correct reservation.',
      '',
      `Amount: ${amountLabel}`,
      `Source: ${sourceLabel}`,
      params.payerName ? `Payer: ${params.payerName}` : '',
      params.reference ? `Reference: ${params.reference}` : '',
      params.occurredAt ? `Received at: ${params.occurredAt.toISOString()}` : '',
      params.matchReason ? `Match note: ${params.matchReason}` : '',
      '',
      `Open payment matching: ${link}`,
      `Correlation ID: ${correlationId}`,
    ].filter(Boolean);

    await this.sendMail({
      subject,
      text: lines.join('\n'),
      correlationId,
      action: 'needs_review',
      metadata: { paymentId: params.paymentId, amount: params.amount },
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

    const link = this.dashboardPaymentsUrl();
    const when =
      slot === 'evening'
        ? 'evening reminder (19:00)'
        : 'morning reminder (08:00)';
    const subject =
      count === 1
        ? `[Hostaway Payments] 1 unmatched payment waiting for assignment`
        : `[Hostaway Payments] ${count} unmatched payments waiting for assignment`;
    const correlationId = `pay-digest-${slot}-${Date.now()}`;

    const sampleLines = samples.map((p) => {
      const amountLabel = new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: p.currency || 'EUR',
      }).format(p.amount);
      const payer = p.payerName || '–';
      const ref = p.reference ? ` — ${p.reference.slice(0, 80)}` : '';
      return `• ${amountLabel} (${p.source}) — ${payer}${ref}`;
    });

    const lines = [
      `There ${count === 1 ? 'is' : 'are'} currently ${count} unmatched payment${count === 1 ? '' : 's'} waiting to be assigned.`,
      'Please review and assign them in the payment matching dashboard.',
      '',
      `This is the scheduled ${when}.`,
      '',
      'Recent items:',
      ...sampleLines,
      samples.length < count ? `… and ${count - samples.length} more` : '',
      '',
      `Open payment matching: ${link}`,
      `Correlation ID: ${correlationId}`,
    ].filter(Boolean);

    await this.sendMail({
      subject,
      text: lines.join('\n'),
      correlationId,
      action: 'review_digest',
      metadata: { slot, count },
    });
    return { sent: true, count };
  }
}

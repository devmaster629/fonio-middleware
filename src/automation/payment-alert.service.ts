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

    const host = this.config.get<string>('PAYMENT_ALERT_SMTP_HOST');
    const port = Number(this.config.get<string>('PAYMENT_ALERT_SMTP_PORT') ?? 587);
    const user = this.config.get<string>('PAYMENT_ALERT_SMTP_USER');
    const pass = this.config.get<string>('PAYMENT_ALERT_SMTP_PASS');
    const from = this.config.get<string>('PAYMENT_ALERT_FROM');
    const to = this.config.get<string>('PAYMENT_ALERT_TO');

    if (!host || !from || !to) {
      this.logger.warn(
        'Payment alerts enabled but SMTP host/from/to are incomplete; skipping email',
      );
      await this.audit.log({
        level: LogLevel.WARN,
        source: 'payment_alert',
        action: 'email_skipped_incomplete_config',
        metadata: {
          reservationHostawayId: params.reservationHostawayId,
          chargeId: params.chargeId,
          hasHost: Boolean(host),
          hasFrom: Boolean(from),
          hasTo: Boolean(to),
        },
      });
      return;
    }

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

    const { default: nodemailer } = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: this.config.get<string>('PAYMENT_ALERT_SMTP_SECURE') === 'true',
      auth: user && pass ? { user, pass } : undefined,
    });

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
      `Correlation ID: ${correlationId}`,
      '',
      'This notification was sent by the middleware because Hostaway does not reliably email for API-created offline paid charges.',
    ].filter(Boolean);

    try {
      const info = await transporter.sendMail({
        from,
        to,
        subject,
        text: lines.join('\n'),
        headers: { 'X-Correlation-Id': correlationId },
      });
      const accepted = Array.isArray(info.accepted) ? info.accepted : [];
      const rejected = Array.isArray(info.rejected) ? info.rejected : [];
      this.logger.log(
        `Payment alert sent for reservation ${params.reservationHostawayId} charge ${params.chargeId} messageId=${info.messageId ?? 'n/a'} accepted=${accepted.join(',') || 'none'} rejected=${rejected.join(',') || 'none'} response=${info.response ?? 'n/a'} correlationId=${correlationId}`,
      );
      await this.audit.log({
        level: LogLevel.INFO,
        source: 'payment_alert',
        action: 'email_sent',
        metadata: {
          correlationId,
          reservationHostawayId: params.reservationHostawayId,
          chargeId: params.chargeId,
          to,
          from,
          subject,
          messageId: info.messageId ?? null,
          accepted,
          rejected,
          response: info.response ?? null,
          appliedMode: params.appliedMode,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown payment alert error';
      this.logger.error(
        `Payment alert failed for reservation ${params.reservationHostawayId}: ${message} correlationId=${correlationId}`,
      );
      await this.audit.log({
        level: LogLevel.ERROR,
        source: 'payment_alert',
        action: 'email_failed',
        metadata: {
          correlationId,
          reservationHostawayId: params.reservationHostawayId,
          chargeId: params.chargeId,
          to,
          from,
          subject,
          error: message,
        },
      });
    }
  }
}

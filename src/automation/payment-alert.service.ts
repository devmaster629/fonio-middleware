import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalPaymentSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentAlertService {
  private readonly logger = new Logger(PaymentAlertService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
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
      '',
      'This notification was sent by the middleware because Hostaway does not reliably email for API-created offline paid charges.',
    ].filter(Boolean);

    try {
      await transporter.sendMail({
        from,
        to,
        subject,
        text: lines.join('\n'),
      });
      this.logger.log(
        `Payment alert sent for reservation ${params.reservationHostawayId} charge ${params.chargeId}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown payment alert error';
      this.logger.error(
        `Payment alert failed for reservation ${params.reservationHostawayId}: ${message}`,
      );
    }
  }
}

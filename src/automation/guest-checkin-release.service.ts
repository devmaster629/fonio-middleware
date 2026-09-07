import { Injectable, Logger } from '@nestjs/common';
import { HostawayConversationService } from '../hostaway/hostaway-conversation.service';
import { HostawayMessagingService } from '../hostaway/hostaway-messaging.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Sends Hostaway Anreise / check-in templates only after payment was received.
 * Used after external payment apply and as a gate for Fonio on-demand send.
 */
@Injectable()
export class GuestCheckinReleaseService {
  private readonly logger = new Logger(GuestCheckinReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: HostawayConversationService,
    private readonly messaging: HostawayMessagingService,
  ) {}

  /** True when the guest has paid at least a deposit / first installment. */
  async hasQualifyingPayment(reservationHostawayId: number): Promise<boolean> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId: reservationHostawayId },
      include: { notifiedCharges: true },
    });
    if (!reservation) return false;
    if (reservation.isPaid === true) return true;
    if ((reservation.paymentPhase ?? '').toLowerCase() === 'deposit_paid') {
      return true;
    }
    const paid = reservation.notifiedCharges.reduce(
      (sum, c) => sum + (Number(c.amount) || 0),
      0,
    );
    return paid > 0.5;
  }

  /**
   * After a payment is booked: send Anreiseinfo once (email via Hostaway template).
   */
  async releaseAfterPayment(reservationHostawayId: number): Promise<{
    sent: boolean;
    reason?: string;
  }> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId: reservationHostawayId },
      include: { listing: true, notifiedCharges: true },
    });
    if (!reservation) {
      return { sent: false, reason: 'reservation_not_found' };
    }
    if (reservation.checkinInfoSentAt) {
      return { sent: false, reason: 'already_sent' };
    }

    const paid = await this.hasQualifyingPayment(reservationHostawayId);
    if (!paid) {
      return { sent: false, reason: 'payment_required' };
    }

    const template = await this.messaging.resolveCheckinTemplate({
      reservationHostawayId: reservation.hostawayId,
      listingHostawayId: reservation.listing.hostawayId,
    });
    if (!template) {
      this.logger.warn(
        `No check-in template for reservation ${reservationHostawayId} after payment`,
      );
      return { sent: false, reason: 'no_template' };
    }

    const conversationId = await this.conversations.resolveConversationId(
      reservation.hostawayId,
    );
    if (!conversationId) {
      return { sent: false, reason: 'no_conversation' };
    }

    try {
      await this.messaging.sendCheckinInfoEmail({
        conversationId,
        template,
      });
      await this.prisma.reservation.update({
        where: { id: reservation.id },
        data: { checkinInfoSentAt: new Date() },
      });
      this.logger.log(
        `Check-in info sent for reservation ${reservationHostawayId} after payment`,
      );
      return { sent: true };
    } catch (err) {
      this.logger.warn(
        `Check-in send failed for ${reservationHostawayId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return { sent: false, reason: 'send_failed' };
    }
  }
}

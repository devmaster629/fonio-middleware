import { Injectable, Logger } from '@nestjs/common';
import { HostawayClient } from '../hostaway/hostaway.client';
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
    private readonly hostaway: HostawayClient,
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
   * CHECK24 imports keep email/phone off Hostaway until payment (so Anreise
   * automations have no recipient). Push stored local contact to Hostaway once paid.
   */
  async attachStoredGuestContactAfterPayment(
    reservationHostawayId: number,
  ): Promise<{ attached: boolean; reason?: string }> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId: reservationHostawayId },
      select: { guestEmail: true, guestPhone: true },
    });
    if (!reservation) return { attached: false, reason: 'reservation_not_found' };

    const guestEmail = reservation.guestEmail?.trim() || undefined;
    const guestPhone = reservation.guestPhone?.trim() || undefined;
    if (!guestEmail && !guestPhone) {
      return { attached: false, reason: 'no_local_contact' };
    }

    try {
      await this.hostaway.updateReservation(reservationHostawayId, {
        ...(guestEmail ? { guestEmail } : {}),
        ...(guestPhone ? { phone: guestPhone } : {}),
      });
      this.logger.log(
        `Attached stored guest contact to Hostaway reservation ${reservationHostawayId} after payment`,
      );
      return { attached: true };
    } catch (err) {
      this.logger.warn(
        `Failed to attach guest contact after payment for ${reservationHostawayId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return { attached: false, reason: 'hostaway_update_failed' };
    }
  }

  /**
   * After a payment is booked: attach deferred contact, then send Anreiseinfo once.
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

    await this.attachStoredGuestContactAfterPayment(reservationHostawayId);

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

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RequestType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HostawayConversationService } from './hostaway-conversation.service';
import { HostawayMessagingService } from './hostaway-messaging.service';

const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  ADD_GUEST: 'Zusätzlicher Gast',
  ADD_PET: 'Haustier',
  CANCELLATION: 'Storno',
  MODIFICATION: 'Buchungsänderung',
  EARLY_CHECKIN: 'Früher Check-in',
  LATE_CHECKOUT: 'Später Check-out',
  RESERVATION_QUESTION: 'Buchungsfrage',
  OTHER: 'Sonstige Anfrage',
};

export interface ForwardGuestRequestParams {
  guestRequestId: string;
  reservationHostawayId: number;
  requestType: RequestType;
  listingName: string;
  summaryLines: string[];
  ruleReason?: string;
  callerNote?: string;
}

@Injectable()
export class GuestRequestInboxService {
  private readonly logger = new Logger(GuestRequestInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: HostawayConversationService,
    private readonly messaging: HostawayMessagingService,
  ) {}

  async postInboxMessage(
    reservationHostawayId: number,
    send: (conversationId: number) => Promise<number>,
  ): Promise<{
    posted: boolean;
    conversationId?: number;
    messageId?: number;
    inboxPending: boolean;
    error?: string;
  }> {
    const conversationId = await this.conversations.resolveConversationId(
      reservationHostawayId,
    );

    if (!conversationId) {
      this.logger.warn(
        `No Hostaway conversation for reservation ${reservationHostawayId} — inbox note pending`,
      );
      return {
        posted: false,
        inboxPending: true,
        error: 'No Hostaway guest conversation found for this reservation',
      };
    }

    try {
      const messageId = await send(conversationId);
      return {
        posted: true,
        conversationId,
        messageId,
        inboxPending: false,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Hostaway message send failed';
      this.logger.error(
        `Failed to post inbox message for reservation ${reservationHostawayId}: ${message}`,
      );
      return {
        posted: false,
        conversationId,
        inboxPending: true,
        error: message,
      };
    }
  }

  async notifyAppliedChange(params: {
    guestRequestId: string;
    reservationHostawayId: number;
    requestType: RequestType;
    additionalGuests?: number;
  }): Promise<{
    posted: boolean;
    conversationId?: number;
    messageId?: number;
    inboxPending: boolean;
    error?: string;
  }> {
    const result = await this.postInboxMessage(
      params.reservationHostawayId,
      (conversationId) =>
        this.messaging.notifyAppliedChangeToInbox({
          conversationId,
          requestType: params.requestType,
          additionalGuests: params.additionalGuests,
        }),
    );

    if (result.posted && result.messageId) {
      await this.prisma.guestRequest.update({
        where: { id: params.guestRequestId },
        data: {
          forwardedToHostaway: true,
          hostawayMessageId: result.messageId,
        },
      });
    }

    return result;
  }

  async notifyPaymentReceived(params: {
    reservationHostawayId: number;
    amount: number;
    currency?: string;
    occurredAt?: Date;
    paymentMethodLabel?: string;
    source?: 'hostaway' | 'fonio';
  }): Promise<{
    posted: boolean;
    conversationId?: number;
    messageId?: number;
    inboxPending: boolean;
    error?: string;
  }> {
    return this.postInboxMessage(params.reservationHostawayId, (conversationId) =>
      this.messaging.notifyPaymentReceivedToInbox({
        conversationId,
        amount: params.amount,
        currency: params.currency,
        occurredAt: params.occurredAt,
        paymentMethodLabel: params.paymentMethodLabel,
        source: params.source,
      }),
    );
  }

  async requestOutstandingPayment(params: {
    reservationHostawayId: number;
    amount: number;
    currency?: string;
    portalName?: string;
    dueByDaysBeforeArrival?: number | null;
    paymentDeadlineDays?: number | null;
  }): Promise<{
    posted: boolean;
    conversationId?: number;
    messageId?: number;
    inboxPending: boolean;
    error?: string;
  }> {
    return this.postInboxMessage(params.reservationHostawayId, (conversationId) =>
      this.messaging.requestOutstandingPaymentToInbox({
        conversationId,
        amount: params.amount,
        currency: params.currency,
        portalName: params.portalName,
        dueByDaysBeforeArrival: params.dueByDaysBeforeArrival,
        paymentDeadlineDays: params.paymentDeadlineDays,
      }),
    );
  }

  async forwardGuestRequest(
    params: ForwardGuestRequestParams,
  ): Promise<{
    forwarded: boolean;
    conversationId?: number;
    messageId?: number;
    inboxPending: boolean;
    error?: string;
  }> {
    const result = await this.postInboxMessage(
      params.reservationHostawayId,
      (conversationId) =>
        this.messaging.forwardRequestToInbox({
          conversationId,
          guestRequestId: params.guestRequestId,
          requestType: params.requestType,
          requestTypeLabel: REQUEST_TYPE_LABELS[params.requestType],
          summary: params.summaryLines.join('\n'),
          ruleReason: params.ruleReason,
          callerNote: params.callerNote,
        }),
    );

    if (result.posted && result.messageId) {
      await this.prisma.guestRequest.update({
        where: { id: params.guestRequestId },
        data: {
          forwardedToHostaway: true,
          hostawayMessageId: result.messageId,
        },
      });
    }

    return {
      forwarded: result.posted,
      conversationId: result.conversationId,
      messageId: result.messageId,
      inboxPending: result.inboxPending,
      error: result.error,
    };
  }

  async retryForward(guestRequestId: string) {
    const request = await this.prisma.guestRequest.findUnique({
      where: { id: guestRequestId },
      include: {
        reservation: { include: { listing: true } },
      },
    });

    if (!request) throw new NotFoundException('Guest request not found');
    if (!request.reservation) {
      throw new NotFoundException('Reservation not linked to guest request');
    }
    if (request.status !== 'FORWARDED') {
      return {
        retried: false,
        message: 'Only forwarded (manual) requests can be sent to Hostaway inbox',
      };
    }
    if (request.forwardedToHostaway) {
      return {
        retried: false,
        message: 'Already forwarded to Hostaway',
        hostawayMessageId: request.hostawayMessageId,
      };
    }

    const payload = request.payload as {
      details?: Record<string, unknown>;
      ruleReason?: string;
    };

    const summaryLines = [
      `Unterkunft: ${request.reservation.listing.name}`,
      `Reservierung: ${request.reservation.hostawayId}`,
    ];
    if (payload.details) {
      for (const [key, value] of Object.entries(payload.details)) {
        summaryLines.push(`${key}: ${String(value)}`);
      }
    }

    const result = await this.forwardGuestRequest({
      guestRequestId: request.id,
      reservationHostawayId: request.reservation.hostawayId,
      requestType: request.requestType,
      listingName: request.reservation.listing.name,
      summaryLines,
      ruleReason: payload.ruleReason,
      callerNote: payload.details?.note as string | undefined,
    });

    return { retried: true, ...result };
  }

  /** Retry inbox delivery for FORWARDED requests that could not reach Hostaway earlier. */
  async retryPendingForwards(limit = 50): Promise<{
    attempted: number;
    succeeded: number;
  }> {
    const pending = await this.prisma.guestRequest.findMany({
      where: {
        status: 'FORWARDED',
        forwardedToHostaway: false,
      },
      take: limit,
      orderBy: { createdAt: 'asc' },
      include: {
        reservation: { include: { listing: true } },
      },
    });

    let succeeded = 0;
    for (const request of pending) {
      if (!request.reservation) continue;
      const result = await this.retryForward(request.id);
      if ('forwarded' in result && result.forwarded) succeeded += 1;
    }

    if (pending.length > 0) {
      this.logger.log(
        `Pending inbox retry: ${succeeded}/${pending.length} delivered`,
      );
    }

    return { attempted: pending.length, succeeded };
  }
}

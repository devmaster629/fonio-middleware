import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HostawayClient } from '../hostaway/hostaway.client';
import { HostawaySyncService } from '../hostaway/hostaway-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { Check24Client } from './check24.client';
import { Check24Booking, Check24WebhookNotification } from './check24.types';

@Injectable()
export class Check24BookingService {
  private readonly logger = new Logger(Check24BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly check24: Check24Client,
    private readonly hostaway: HostawayClient,
    private readonly hostawaySync: HostawaySyncService,
  ) {}

  async handleWebhookNotification(notification: Check24WebhookNotification) {
    const bookingId = String(notification.bookingId ?? '').trim();
    if (!bookingId) {
      return { processed: false, reason: 'missing bookingId' };
    }

    const booking = await this.check24.getBooking(bookingId);
    return this.processBooking(booking);
  }

  async pollRecentBookings() {
    if (!this.check24.isConfigured()) {
      return { processed: 0, skipped: true };
    }
    const bookings = await this.check24.listBookings({ limit: 50, offset: 0 });
    let processed = 0;
    const errors: Array<{ bookingId: string; error: string }> = [];
    for (const booking of bookings) {
      try {
        const result = await this.processBooking(booking);
        if (result.processed) processed += 1;
      } catch (err) {
        const message = this.check24.describeError(err);
        errors.push({ bookingId: booking.bookingId, error: message });
        this.logger.warn(
          `CHECK24 booking poll failed for ${booking.bookingId}: ${message}`,
        );
      }
    }
    return { processed, total: bookings.length, errors };
  }

  async processBooking(booking: Check24Booking) {
    const existing = await this.prisma.check24Booking.findUnique({
      where: { check24BookingId: booking.bookingId },
    });

    await this.prisma.check24Booking.upsert({
      where: { check24BookingId: booking.bookingId },
      create: {
        check24BookingId: booking.bookingId,
        check24PropertyId: booking.propertyId,
        status: booking.status,
        rawPayload: booking as object,
      },
      update: {
        check24PropertyId: booking.propertyId,
        status: booking.status,
        rawPayload: booking as object,
      },
    });

    if (booking.status === 'declined' || booking.status === 'canceled') {
      await this.prisma.check24Booking.update({
        where: { check24BookingId: booking.bookingId },
        data: { processedAt: new Date(), lastError: null },
      });
      return {
        processed: true,
        action: 'ignored_terminal_status',
        status: booking.status,
        hostawayReservationId: existing?.hostawayReservationId ?? null,
      };
    }

    if (existing?.hostawayReservationId) {
      return {
        processed: false,
        action: 'already_imported',
        hostawayReservationId: existing.hostawayReservationId,
      };
    }

    if (booking.status !== 'requested' && booking.status !== 'booked') {
      return {
        processed: false,
        action: 'unsupported_status',
        status: booking.status,
      };
    }

    const mapping = await this.prisma.check24PropertyMapping.findUnique({
      where: { check24PropertyId: booking.propertyId },
      include: { listing: true },
    });
    if (!mapping?.listing) {
      const msg = `No local mapping for CHECK24 property ${booking.propertyId}`;
      await this.prisma.check24Booking.update({
        where: { check24BookingId: booking.bookingId },
        data: { lastError: msg },
      });
      throw new Error(msg);
    }

    const channelId = Number(this.config.get('CHECK24_HOSTAWAY_CHANNEL_ID') ?? 2000);
    const guest = booking.guest ?? {};
    const booker = booking.booker ?? {};
    const firstName =
      guest.firstName?.trim() || booker.firstName?.trim() || 'CHECK24';
    const lastName =
      guest.lastName?.trim() || booker.lastName?.trim() || 'Guest';
    const guestName = `${firstName} ${lastName}`.trim();
    const childrenCount = this.countChildren(booking);
    const adults = Math.max(1, booking.numberAdults ?? 1);
    const numberOfGuests = adults + childrenCount;

    const payload: Record<string, unknown> = {
      channelId,
      listingMapId: mapping.listing.hostawayId,
      guestName,
      guestFirstName: firstName,
      guestLastName: lastName,
      guestEmail: guest.email?.trim() || undefined,
      phone: guest.phone?.trim() || undefined,
      numberOfGuests,
      adults,
      children: childrenCount || undefined,
      arrivalDate: booking.dateFrom,
      departureDate: booking.dateTo,
      totalPrice: booking.totalPrice ?? undefined,
      currency: booking.currencyCode ?? 'EUR',
      hostNote: `[CHECK24 ${booking.bookingId}] status=${booking.status}${
        booking.comments ? ` — ${booking.comments}` : ''
      }`.slice(0, 500),
      guestNote: booking.comments?.slice(0, 500) ?? null,
      isManuallyEntered: 1,
    };

    const created = await this.hostaway.createReservation(payload);
    await this.hostawaySync.syncSingleReservation(created.id).catch((err) => {
      this.logger.warn(
        `CHECK24 booking ${booking.bookingId} created Hostaway ${created.id} but local sync failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    });

    await this.prisma.check24Booking.update({
      where: { check24BookingId: booking.bookingId },
      data: {
        hostawayReservationId: created.id,
        processedAt: new Date(),
        lastError: null,
        status: booking.status,
      },
    });

    const autoAccept =
      (this.config.get<string>('CHECK24_AUTO_ACCEPT_ENQUIRY') ?? 'true')
        .toLowerCase() !== 'false';

    if (booking.status === 'requested' && autoAccept) {
      try {
        await this.check24.acceptBooking(booking.bookingId);
        await this.prisma.check24Booking.update({
          where: { check24BookingId: booking.bookingId },
          data: { status: 'booked' },
        });
      } catch (err) {
        const message = this.check24.describeError(err);
        this.logger.warn(
          `Imported booking ${booking.bookingId} but CHECK24 accept failed: ${message}`,
        );
        await this.prisma.check24Booking.update({
          where: { check24BookingId: booking.bookingId },
          data: {
            lastError: `Imported to Hostaway ${created.id}; accept failed: ${message}`.slice(
              0,
              1000,
            ),
          },
        });
      }
    }

    return {
      processed: true,
      action: 'imported',
      hostawayReservationId: created.id,
      status: booking.status,
    };
  }

  async registerWebhook(publicBaseUrl?: string) {
    const base = (
      publicBaseUrl ??
      this.config.get<string>('PRODUCTION_URL') ??
      this.config.get<string>('APP_URL') ??
      'https://vermietung.brainions.digital'
    ).replace(/\/$/, '');

    const url = `${base}/webhooks/check24/bookings`;
    const username = this.config.get<string>('CHECK24_WEBHOOK_USERNAME');
    const password = this.config.get<string>('CHECK24_WEBHOOK_PASSWORD');

    const registration = {
      url,
      ...(username && password
        ? { authorization: { username, password } }
        : {}),
    };

    const result = await this.check24.registerBookingWebhook(registration);
    return { url, result };
  }

  async listLocalBookings(limit = 50) {
    return this.prisma.check24Booking.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
    });
  }

  private countChildren(booking: Check24Booking): number {
    const children = booking.children;
    if (!children) return 0;
    if (Array.isArray(children)) return children.length;
    if (Array.isArray(children.ages)) return children.ages.length;
    return 0;
  }
}

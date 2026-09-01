import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GuestPaymentAutomationService } from '../automation/guest-payment-automation.service';
import { HostawayClient } from '../hostaway/hostaway.client';
import { HostawaySyncService } from '../hostaway/hostaway-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { Check24Client } from './check24.client';
import { Check24SyncService } from './check24-sync.service';
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
    private readonly check24Sync: Check24SyncService,
    private readonly guestPayments: GuestPaymentAutomationService,
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

    if (this.isTerminalStatus(booking.status)) {
      return this.cancelImportedReservation(booking, existing);
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
    await this.applyHostawayCheck24Labels(created.id, booking.bookingId);
    await this.hostawaySync.syncSingleReservation(created.id).catch((err) => {
      this.logger.warn(
        `CHECK24 booking ${booking.bookingId} created Hostaway ${created.id} but local sync failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    });

    const paymentResult = await this.guestPayments
      .requestPaymentOnImport(created.id, {
        hostNote: String(payload.hostNote ?? ''),
        guestEmail: guest.email?.trim() || undefined,
      })
      .catch((err) => {
        this.logger.warn(
          `CHECK24 payment request failed for Hostaway ${created.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return { ok: false, reason: 'error' };
      });
    if (paymentResult.ok) {
      this.logger.log(
        `CHECK24 guest payment request sent for Hostaway ${created.id}`,
      );
    }

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

    await this.pushAvailabilityAfterBookingChange(
      mapping.listing.id,
      mapping.listing.hostawayId,
      booking.bookingId,
    );

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
    const bookings = await this.prisma.check24Booking.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
    });

    const propertyIds = [
      ...new Set(bookings.map((b) => b.check24PropertyId).filter(Boolean)),
    ];
    const mappings =
      propertyIds.length === 0
        ? []
        : await this.prisma.check24PropertyMapping.findMany({
            where: { check24PropertyId: { in: propertyIds } },
            include: { listing: { select: { name: true, hostawayId: true } } },
          });
    const byPropertyId = new Map(
      mappings.map((m) => [m.check24PropertyId, m] as const),
    );

    return bookings.map((booking) => {
      const mapping = byPropertyId.get(booking.check24PropertyId);
      const raw =
        booking.rawPayload && typeof booking.rawPayload === 'object'
          ? (booking.rawPayload as Record<string, unknown>)
          : {};
      const guest =
        raw.guest && typeof raw.guest === 'object'
          ? (raw.guest as Record<string, unknown>)
          : {};
      const guestName = [guest.firstName, guest.lastName]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join(' ');

      return {
        ...booking,
        listingName: mapping?.listing?.name ?? null,
        listingHostawayId: mapping?.listing?.hostawayId ?? null,
        dateFrom: typeof raw.dateFrom === 'string' ? raw.dateFrom : null,
        dateTo: typeof raw.dateTo === 'string' ? raw.dateTo : null,
        guestName: guestName || null,
        totalPrice:
          typeof raw.totalPrice === 'number' ? raw.totalPrice : null,
        currencyCode:
          typeof raw.currencyCode === 'string' ? raw.currencyCode : null,
      };
    });
  }

  private async cancelImportedReservation(
    booking: Check24Booking,
    existing: { hostawayReservationId: number | null } | null,
  ) {
    const hostawayReservationId = existing?.hostawayReservationId ?? null;
    if (!hostawayReservationId) {
      await this.prisma.check24Booking.update({
        where: { check24BookingId: booking.bookingId },
        data: {
          processedAt: new Date(),
          lastError: null,
          status: booking.status,
        },
      });
      return {
        processed: true,
        action: 'ignored_terminal_status',
        status: booking.status,
        hostawayReservationId: null,
      };
    }

    const local = await this.prisma.reservation.findUnique({
      where: { hostawayId: hostawayReservationId },
      select: { status: true },
    });
    if (this.isHostawayCancelled(local?.status)) {
      await this.prisma.check24Booking.update({
        where: { check24BookingId: booking.bookingId },
        data: {
          processedAt: new Date(),
          lastError: null,
          status: booking.status,
        },
      });
      return {
        processed: true,
        action: 'already_cancelled',
        status: booking.status,
        hostawayReservationId,
      };
    }

    try {
      await this.hostaway.cancelReservation(hostawayReservationId);
      await this.hostawaySync.syncSingleReservation(hostawayReservationId).catch((err) => {
        this.logger.warn(
          `CHECK24 booking ${booking.bookingId} cancelled Hostaway ${hostawayReservationId} but local sync failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      });
      await this.prisma.check24Booking.update({
        where: { check24BookingId: booking.bookingId },
        data: {
          processedAt: new Date(),
          lastError: null,
          status: booking.status,
        },
      });

      const mapping = await this.prisma.check24PropertyMapping.findUnique({
        where: { check24PropertyId: booking.propertyId },
        include: { listing: true },
      });
      if (mapping?.listing) {
        await this.pushAvailabilityAfterBookingChange(
          mapping.listing.id,
          mapping.listing.hostawayId,
          booking.bookingId,
        );
      }

      return {
        processed: true,
        action: 'cancelled_in_hostaway',
        status: booking.status,
        hostawayReservationId,
      };
    } catch (err) {
      const message = this.check24.describeError(err);
      this.logger.warn(
        `CHECK24 booking ${booking.bookingId} cancel in Hostaway ${hostawayReservationId} failed: ${message}`,
      );
      await this.prisma.check24Booking.update({
        where: { check24BookingId: booking.bookingId },
        data: {
          lastError: `Hostaway cancel failed: ${message}`.slice(0, 1000),
          status: booking.status,
        },
      });
      return {
        processed: false,
        action: 'cancel_failed',
        status: booking.status,
        hostawayReservationId,
        error: message,
      };
    }
  }

  /**
   * Hostaway UI cannot add a custom channel name. We set channelId on create
   * (CHECK24_HOSTAWAY_CHANNEL_ID) and fill custom field "Buchungsportal".
   */
  private async pushAvailabilityAfterBookingChange(
    listingId: string,
    hostawayListingId: number,
    check24BookingId: string,
  ) {
    const result = await this.check24Sync
      .refreshAndPushAvailability(listingId, hostawayListingId)
      .catch((err) => {
        this.logger.warn(
          `CHECK24 availability push after booking ${check24BookingId} failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return { pushed: false, reason: 'error' };
      });
    if (!result.pushed) {
      this.logger.warn(
        `CHECK24 dates not pushed for booking ${check24BookingId} (listing ${hostawayListingId}): ${result.reason ?? 'unknown'}`,
      );
    }
  }

  private async applyHostawayCheck24Labels(
    reservationId: number,
    check24BookingId: string,
  ) {
    try {
      const portalValue =
        this.config.get<string>('CHECK24_HOSTAWAY_BUCHUNGSPORTAL_VALUE') ??
        'CHECK24';
      const configuredFieldId = Number(
        this.config.get('CHECK24_HOSTAWAY_CUSTOM_FIELD_ID') ?? 0,
      );
      const fields = await this.hostaway.getCustomFields();
      const values: Array<{ customFieldId: number; value: string }> = [];

      const portalField =
        (configuredFieldId > 0
          ? fields.find((f) => f.id === configuredFieldId)
          : undefined) ??
        this.findCustomField(fields, [
          'buchungsportal',
          'reservation_buchungsportal',
        ]);
      if (portalField) {
        values.push({ customFieldId: portalField.id, value: portalValue });
      } else {
        this.logger.warn(
          `Hostaway custom field Buchungsportal not found — reservation ${reservationId} has no CHECK24 portal label`,
        );
      }

      const externalField = this.findCustomField(fields, [
        'externe buchungsnummer',
        'externe_buchungsnummer',
        'reservation_externe_buchungsnummer',
      ]);
      if (externalField) {
        values.push({
          customFieldId: externalField.id,
          value: check24BookingId,
        });
      }

      if (values.length === 0) return;

      await this.hostaway.updateReservation(reservationId, {
        customFieldValues: values,
      });
    } catch (err) {
      this.logger.warn(
        `Could not set CHECK24 Hostaway custom fields on reservation ${reservationId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  private findCustomField(
    fields: Array<{ id: number; name?: string | null; varName?: string | null }>,
    needles: string[],
  ) {
    return fields.find((field) => {
      const hay = `${field.name ?? ''} ${field.varName ?? ''}`.toLowerCase();
      return needles.some((n) => hay.includes(n.toLowerCase()));
    });
  }

  private isTerminalStatus(status?: string) {
    const normalized = (status ?? '').toLowerCase();
    return (
      normalized === 'declined' ||
      normalized === 'canceled' ||
      normalized === 'cancelled' ||
      normalized === 'failed'
    );
  }

  private isHostawayCancelled(status?: string | null) {
    const normalized = (status ?? '').toLowerCase();
    return (
      normalized === 'cancelled' ||
      normalized === 'canceled' ||
      normalized === 'declined' ||
      normalized === 'expired'
    );
  }

  private countChildren(booking: Check24Booking): number {
    const children = booking.children;
    if (!children) return 0;
    if (Array.isArray(children)) return children.length;
    if (Array.isArray(children.ages)) return children.ages.length;
    return 0;
  }
}

import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GuestCheckinReleaseService } from '../automation/guest-checkin-release.service';
import { GuestPaymentAutomationService } from '../automation/guest-payment-automation.service';
import {
  hashPhoneForStorage,
  hashValue,
} from '../common/utils/crypto.util';
import { HostawayClient } from '../hostaway/hostaway.client';
import { HostawaySyncService } from '../hostaway/hostaway-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { Check24Client } from './check24.client';
import { Check24SyncService } from './check24-sync.service';
import { Check24SyncSettingsService } from './check24-sync-settings.service';
import {
  Check24Booking,
  Check24CancelBookingPayload,
  Check24CancelReason,
  Check24WebhookNotification,
} from './check24.types';

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
    private readonly syncSettings: Check24SyncSettingsService,
    @Inject(forwardRef(() => GuestPaymentAutomationService))
    private readonly guestPayments: GuestPaymentAutomationService,
    @Inject(forwardRef(() => GuestCheckinReleaseService))
    private readonly checkinRelease: GuestCheckinReleaseService,
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

    const guestEmail = guest.email?.trim() || undefined;
    const guestPhone = guest.phone?.trim() || undefined;

    // Create WITHOUT guest email/phone so Hostaway "at reservation" automations
    // (pre-check-in / Anreise / WhatsApp) have no recipient.
    // Do NOT attach contact on Hostaway until the deposit is paid — previous
    // "attach immediately after create" undid this and re-triggered Anreise.
    // Contact is stored locally only; GuestCheckinRelease attaches it after payment.
    const customFieldValues = await this.resolveCheck24CustomFieldValues(
      booking.bookingId,
    );
    const payload: Record<string, unknown> = {
      channelId,
      listingMapId: mapping.listing.hostawayId,
      guestName,
      guestFirstName: firstName,
      guestLastName: lastName,
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
      // Prefer labels on create so we avoid a follow-up updateReservation that
      // can re-trigger Hostaway "reservation updated" Anreise automations.
      ...(customFieldValues.length > 0 ? { customFieldValues } : {}),
    };

    let created;
    let labelsOnCreate = customFieldValues.length > 0;
    try {
      created = await this.hostaway.createReservation(payload);
    } catch (err) {
      if (!labelsOnCreate) throw err;
      this.logger.warn(
        `CHECK24 booking ${booking.bookingId}: create with custom fields failed, retrying without: ${
          err instanceof Error ? err.message : err
        }`,
      );
      delete payload.customFieldValues;
      labelsOnCreate = false;
      created = await this.hostaway.createReservation(payload);
    }
    // Fallback update only when labels were not part of create (avoids extra
    // "reservation updated" automation triggers when create accepted them).
    if (!labelsOnCreate) {
      await this.applyHostawayCheck24Labels(created.id, booking.bookingId);
    }

    await this.hostawaySync.syncSingleReservation(created.id).catch((err) => {
      this.logger.warn(
        `CHECK24 booking ${booking.bookingId} created Hostaway ${created.id} but local sync failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    });

    // Keep contact only in our DB until payment (Hostaway sync must not wipe this).
    if (guestEmail || guestPhone) {
      try {
        await this.prisma.reservation.updateMany({
          where: { hostawayId: created.id },
          data: {
            ...(guestEmail
              ? { guestEmail, emailHash: hashValue(guestEmail) }
              : {}),
            ...(guestPhone
              ? { guestPhone, phoneHash: hashPhoneForStorage(guestPhone) }
              : {}),
          },
        });
      } catch (err) {
        this.logger.warn(
          `CHECK24 booking ${booking.bookingId}: storing local guest contact failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    const paymentResult = await this.guestPayments
      .requestPaymentOnImport(created.id, {
        hostNote: String(payload.hostNote ?? ''),
        guestEmail,
      })
      .catch((err) => {
        this.logger.warn(
          `CHECK24 payment request failed for Hostaway ${created.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return {
          ok: false as const,
          reason: 'error',
          guestPortalUrl: undefined as string | undefined,
          deadlineAt: undefined as Date | undefined,
        };
      });
    if (paymentResult.ok) {
      this.logger.log(
        `CHECK24 guest payment request sent for Hostaway ${created.id}`,
      );
    }

    const welcome = await this.checkinRelease
      .sendImportWelcome({
        reservationHostawayId: created.id,
        bookingRef: booking.bookingId,
        guestPortalUrl: paymentResult.guestPortalUrl ?? null,
        deadlineAt: paymentResult.deadlineAt ?? null,
        amount:
          paymentResult.ok && booking.totalPrice != null
            ? Number(booking.totalPrice)
            : null,
        currency: booking.currencyCode ?? 'EUR',
      })
      .catch((err) => {
        this.logger.warn(
          `CHECK24 welcome message failed for Hostaway ${created.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return {
          sent: false,
          emailSent: false,
          whatsappSent: false,
          reason: 'error',
        };
      });
    if (welcome.sent) {
      this.logger.log(
        `CHECK24 welcome sent for Hostaway ${created.id} (email=${welcome.emailSent}, whatsapp=${welcome.whatsappSent})`,
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

  /**
   * When a Hostaway reservation linked to CHECK24 is cancelled on our side
   * (unpaid auto-cancel, Hostaway UI, etc.), confirm the cancel on CHECK24
   * via POST /bookings/{id}/cancel and reopen dates.
   */
  async propagateHostawayCancellation(
    hostawayReservationId: number,
    options?: {
      cancelReason?: Check24CancelReason;
      cancelMessage?: string;
    },
  ) {
    if (!this.check24.isConfigured()) {
      return { processed: false, reason: 'check24_not_configured' };
    }

    const linked = await this.prisma.check24Booking.findFirst({
      where: { hostawayReservationId },
    });
    if (!linked) {
      return { processed: false, reason: 'not_check24_booking' };
    }

    const status = (linked.status ?? '').toLowerCase();
    if (this.isTerminalStatus(status)) {
      await this.pushAvailabilityForProperty(
        linked.check24PropertyId,
        linked.check24BookingId,
        await this.stayDatesForHostawayReservation(hostawayReservationId),
      );
      return {
        processed: true,
        action: 'already_terminal_pushed_availability',
        check24BookingId: linked.check24BookingId,
      };
    }

    const payload: Check24CancelBookingPayload = {
      cancelledBy: 'Provider',
      cancelReason: options?.cancelReason ?? 'providerOther',
      cancelMessage:
        options?.cancelMessage ??
        'Cancelled by property management system',
      currencyCode: 'EUR',
      cancelFee: 0,
    };

    try {
      await this.check24.cancelBooking(linked.check24BookingId, payload);
      await this.prisma.check24Booking.update({
        where: { check24BookingId: linked.check24BookingId },
        data: {
          status: 'cancelled',
          processedAt: new Date(),
          lastError: null,
        },
      });
      await this.pushAvailabilityForProperty(
        linked.check24PropertyId,
        linked.check24BookingId,
        await this.stayDatesForHostawayReservation(hostawayReservationId),
      );
      this.logger.log(
        `CHECK24 booking ${linked.check24BookingId} cancelled after Hostaway ${hostawayReservationId}`,
      );
      return {
        processed: true,
        action: 'cancelled_on_check24',
        check24BookingId: linked.check24BookingId,
      };
    } catch (err) {
      const message = this.check24.describeError(err);
      this.logger.warn(
        `CHECK24 cancel for ${linked.check24BookingId} (Hostaway ${hostawayReservationId}) failed: ${message}`,
      );
      await this.prisma.check24Booking.update({
        where: { check24BookingId: linked.check24BookingId },
        data: {
          lastError: `CHECK24 cancel failed: ${message}`.slice(0, 1000),
        },
      });
      // Still reopen dates — Hostaway is cancelled.
      await this.pushAvailabilityForProperty(
        linked.check24PropertyId,
        linked.check24BookingId,
        await this.stayDatesForHostawayReservation(hostawayReservationId),
      );
      return {
        processed: false,
        action: 'check24_cancel_failed',
        check24BookingId: linked.check24BookingId,
        error: message,
      };
    }
  }

  expectedWebhookUrl(publicBaseUrl?: string): string {
    const base = (
      publicBaseUrl ??
      this.config.get<string>('PRODUCTION_URL') ??
      this.config.get<string>('APP_URL') ??
      'https://vermietung.brainions.digital'
    ).replace(/\/$/, '');
    return `${base}/webhooks/check24/bookings`;
  }

  async getWebhookStatus(publicBaseUrl?: string) {
    const expectedUrl = this.expectedWebhookUrl(publicBaseUrl);
    const [settings, last] = await Promise.all([
      this.syncSettings.getOrCreate(),
      this.prisma.apiLog.findFirst({
        where: { source: 'check24_webhook' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, action: true },
      }),
    ]);

    let registeredUrl: string | null = null;
    let lookup: 'ok' | 'missing' | 'error' | 'skipped' = 'skipped';
    let lookupError: string | undefined;
    if (this.check24.isConfigured()) {
      try {
        const remote = await this.check24.getBookingWebhook();
        registeredUrl = this.extractWebhookUrl(remote);
        lookup = remote ? 'ok' : 'missing';
      } catch (err) {
        lookup = 'error';
        lookupError = this.check24.describeError(err);
      }
    }

    return {
      enabled: Boolean(settings.bookingAlertsEnabled),
      registeredAt: settings.bookingAlertsRegisteredAt?.toISOString() ?? null,
      lookup,
      lookupError,
      expectedUrl,
      registeredUrl,
      matches: Boolean(
        registeredUrl &&
          registeredUrl.replace(/\/$/, '') === expectedUrl.replace(/\/$/, ''),
      ),
      lastReceivedAt: last?.createdAt?.toISOString() ?? null,
      lastReceivedAction: last?.action ?? null,
    };
  }

  async registerWebhook(publicBaseUrl?: string) {
    const url = this.expectedWebhookUrl(publicBaseUrl);
    const username = this.config.get<string>('CHECK24_WEBHOOK_USERNAME');
    const password = this.config.get<string>('CHECK24_WEBHOOK_PASSWORD');

    const registration = {
      url,
      ...(username && password
        ? { authorization: { username, password } }
        : {}),
    };

    const result = await this.check24.registerBookingWebhook(registration);
    await this.syncSettings.update({
      bookingAlertsEnabled: true,
      bookingAlertsRegisteredAt: new Date(),
    });
    return { enabled: true, url, result };
  }

  async unregisterWebhook() {
    let remoteDeleted = false;
    let remoteError: string | undefined;
    try {
      await this.check24.deleteBookingWebhook();
      remoteDeleted = true;
    } catch (err) {
      // CHECK24 staging often returns 400 when no webhook exists / delete unsupported.
      // Always clear local On/Off so the UI toggle still works.
      remoteError = this.check24.describeError(err);
      this.logger.warn(`CHECK24 webhook delete failed (continuing local Off): ${remoteError}`);
    }
    await this.syncSettings.update({
      bookingAlertsEnabled: false,
      bookingAlertsRegisteredAt: null,
    });
    return {
      enabled: false,
      remoteDeleted,
      ...(remoteError ? { remoteError } : {}),
    };
  }

  private extractWebhookUrl(payload: unknown): string | null {
    if (!payload) return null;
    if (typeof payload === 'string') {
      const text = payload.trim();
      return text.startsWith('http') ? text : null;
    }
    if (typeof payload !== 'object') return null;
    const rec = payload as Record<string, unknown>;
    const nested =
      rec.webhook && typeof rec.webhook === 'object'
        ? (rec.webhook as Record<string, unknown>)
        : rec;
    const candidates = [
      nested.url,
      nested.webhookUrl,
      nested.callbackUrl,
      rec.url,
      rec.webhookUrl,
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
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
      await this.pushAvailabilityForProperty(
        booking.propertyId,
        booking.bookingId,
        { dateFrom: booking.dateFrom, dateTo: booking.dateTo },
      );
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
      // Always reopen CHECK24 dates even if Hostaway was already cancelled
      // (previous bug: already_cancelled skipped the availability push).
      // Force-open the stay range: Hostaway calendar is often still closed right after cancel.
      await this.pushAvailabilityForProperty(
        booking.propertyId,
        booking.bookingId,
        { dateFrom: booking.dateFrom, dateTo: booking.dateTo },
      );
      return {
        processed: true,
        action: 'already_cancelled',
        status: booking.status,
        hostawayReservationId,
      };
    }

    try {
      // Mark cancelled locally first so Hostaway sync → propagateHostawayCancellation
      // does not POST /cancel again for a guest-initiated CHECK24 cancel.
      await this.prisma.check24Booking.update({
        where: { check24BookingId: booking.bookingId },
        data: {
          processedAt: new Date(),
          lastError: null,
          status: booking.status,
        },
      });
      await this.hostaway.cancelReservation(hostawayReservationId);
      try {
        await this.prisma.reservation.updateMany({
          where: { hostawayId: hostawayReservationId },
          data: { status: 'cancelled' },
        });
      } catch {
        /* best effort — sync below is the source of truth */
      }
      await this.hostawaySync.syncSingleReservation(hostawayReservationId).catch((err) => {
        this.logger.warn(
          `CHECK24 booking ${booking.bookingId} cancelled Hostaway ${hostawayReservationId} but local sync failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      });

      await this.pushAvailabilityForProperty(
        booking.propertyId,
        booking.bookingId,
        { dateFrom: booking.dateFrom, dateTo: booking.dateTo },
      );

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
  private async pushAvailabilityForProperty(
    check24PropertyId: string,
    check24BookingId: string,
    forceOpenStay?: { dateFrom?: string; dateTo?: string } | null,
  ) {
    const mapping = await this.prisma.check24PropertyMapping.findUnique({
      where: { check24PropertyId },
      include: { listing: true },
    });
    if (!mapping?.listing) {
      this.logger.warn(
        `CHECK24 availability push skipped for booking ${check24BookingId}: no mapping for ${check24PropertyId}`,
      );
      return;
    }
    await this.pushAvailabilityAfterBookingChange(
      mapping.listing.id,
      mapping.listing.hostawayId,
      check24BookingId,
      forceOpenStay,
    );
  }

  private async pushAvailabilityAfterBookingChange(
    listingId: string,
    hostawayListingId: number,
    check24BookingId: string,
    forceOpenStay?: { dateFrom?: string; dateTo?: string } | null,
  ) {
    const result = await this.check24Sync
      .refreshAndPushAvailability(listingId, hostawayListingId, {
        forceOpenFrom: forceOpenStay?.dateFrom,
        forceOpenTo: forceOpenStay?.dateTo,
      })
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

  private async stayDatesForHostawayReservation(
    hostawayReservationId: number,
  ): Promise<{ dateFrom?: string; dateTo?: string } | null> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId: hostawayReservationId },
      select: { arrivalDate: true, departureDate: true },
    });
    if (!reservation) return null;
    return {
      dateFrom: reservation.arrivalDate.toISOString().slice(0, 10),
      dateTo: reservation.departureDate.toISOString().slice(0, 10),
    };
  }

  private async applyHostawayCheck24Labels(
    reservationId: number,
    check24BookingId: string,
  ) {
    try {
      const values = await this.resolveCheck24CustomFieldValues(check24BookingId);
      if (values.length === 0) {
        this.logger.warn(
          `Hostaway custom field Buchungsportal not found — reservation ${reservationId} has no CHECK24 portal label`,
        );
        return;
      }

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

  private async resolveCheck24CustomFieldValues(
    check24BookingId: string,
  ): Promise<Array<{ customFieldId: number; value: string }>> {
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

    return values;
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

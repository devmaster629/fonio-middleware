import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GuestPaymentAutomationService } from '../automation/guest-payment-automation.service';
import { HostawayClient } from '../hostaway/hostaway.client';
import { HostawayPriceComponent } from '../hostaway/hostaway.types';
import { HostawaySyncService } from '../hostaway/hostaway-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { FonioAvailabilityService } from './fonio-availability.service';
import { BookingOfferDto } from './dto/booking-offer.dto';

const GUEST_MESSAGE_OK =
  'Vielen Dank — Ihre Anfrage ist aufgenommen. Sie erhalten von uns ein Angebot mit Bitte um Anzahlung. Eine verbindliche Buchungsbestätigung erfolgt erst nach Zahlungseingang der Anzahlung.';

const GUEST_MESSAGE_FAIL =
  'Ihre Kontaktdaten habe ich notiert. Ein Mitarbeiter meldet sich zeitnah mit einem Angebot — eine verbindliche Buchung liegt noch nicht vor.';

@Injectable()
export class FonioBookingOfferService {
  private readonly logger = new Logger(FonioBookingOfferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hostaway: HostawayClient,
    private readonly availability: FonioAvailabilityService,
    private readonly sync: HostawaySyncService,
    private readonly config: ConfigService,
    private readonly guestPayments: GuestPaymentAutomationService,
  ) {}

  async createOffer(dto: BookingOfferDto) {
    if (!(await this.isBookingOfferEnabled())) {
      throw new BadRequestException({
        offerCreated: false,
        message: 'Automatic booking offers are disabled',
        guestMessage: GUEST_MESSAGE_FAIL,
      });
    }

    this.assertRealContact(dto);

    const listing = await this.prisma.listing.findUnique({
      where: { hostawayId: dto.listingId },
    });
    if (!listing || !listing.isBookable) {
      throw new NotFoundException({
        offerCreated: false,
        message: 'Listing not found or not bookable',
        guestMessage: GUEST_MESSAGE_FAIL,
      });
    }

    const search = await this.availability.search({
      city: listing.city ?? undefined,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      guests: dto.guests,
      pets: (dto.pets ?? 0) > 0,
      availableOnly: true,
    });

    const match = search.results.find(
      (r) => r.listingId === dto.listingId && r.available,
    );
    if (!match) {
      throw new BadRequestException({
        offerCreated: false,
        message: 'Selected listing is not available for these dates',
        availableCount: search.availableCount,
        guestMessage:
          'Für diese Unterkunft und Daten ist aktuell nichts frei. Gerne prüfen wir andere Daten oder Orte.',
      });
    }

    const price = await this.hostaway.calculatePriceDetails(dto.listingId, {
      startingDate: dto.checkIn,
      endingDate: dto.checkOut,
      numberOfGuests: dto.guests,
    });

    const channelId = Number(this.config.get('BOOKING_OFFER_CHANNEL_ID') ?? 2000);
    const guestName = `${dto.guestFirstName.trim()} ${dto.guestLastName.trim()}`.trim();
    const hostNote = dto.note
      ? `[fonio.ai – Buchungsanfrage] ${dto.note}`.slice(0, 500)
      : '[fonio.ai – Buchungsanfrage] Telefonische Anfrage – Angebot + Anzahlung, Bestätigung erst nach Zahlungseingang';

    // Always create as Hostaway inquiry — never a confirmed booking on the phone.
    // Calendar stays open until a deposit is received and the inquiry is promoted.
    const payload: Record<string, unknown> = {
      channelId,
      listingMapId: dto.listingId,
      status: 'inquiry',
      guestName,
      guestFirstName: dto.guestFirstName.trim(),
      guestLastName: dto.guestLastName.trim(),
      guestEmail: dto.guestEmail.trim(),
      phone: dto.phone.trim(),
      numberOfGuests: dto.guests,
      adults: dto.guests,
      arrivalDate: dto.checkIn,
      departureDate: dto.checkOut,
      totalPrice: price.totalPrice,
      currency: 'EUR',
      financeField: price.components.map((c) => this.toFinanceField(c)),
      hostNote,
      guestNote: dto.note?.slice(0, 500) ?? null,
      pets: dto.pets ?? null,
      isManuallyEntered: 1,
    };

    const created = await this.hostaway.createReservation(payload);
    const reservationId = created.id;

    try {
      await this.syncLocalReservation(reservationId);
      await this.ensureInquiryStatus(reservationId);

      const paymentResult = await this.guestPayments.requestDepositAfterFonioOffer(
        reservationId,
        {
          hostNote,
          guestEmail: dto.guestEmail.trim(),
        },
      );

      if (!paymentResult.ok) {
        this.logger.error(
          `Fonio offer ${reservationId}: deposit request failed (${paymentResult.reason}) — rolling back`,
        );
        await this.rollbackOffer(reservationId);
        throw new ServiceUnavailableException({
          offerCreated: false,
          depositRequested: false,
          depositRequestReason: paymentResult.reason,
          message:
            'Booking inquiry was not kept because the deposit request could not be sent',
          guestMessage: GUEST_MESSAGE_FAIL,
        });
      }

      this.logger.log(
        `Fonio inquiry ${reservationId} created with deposit request for ${listing.name}`,
      );

      // Do not return totalPrice to fonio — the model must not quote prices on the phone.
      return {
        offerCreated: true,
        reservationId,
        listingId: dto.listingId,
        listingName: listing.name,
        checkIn: dto.checkIn,
        checkOut: dto.checkOut,
        guests: dto.guests,
        currency: 'EUR',
        status: 'inquiry',
        depositRequested: true,
        message:
          'Booking inquiry created in Hostaway (not confirmed). Deposit request sent; confirmation only after payment.',
        guestMessage: GUEST_MESSAGE_OK,
      };
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException ||
        err instanceof ServiceUnavailableException
      ) {
        throw err;
      }
      this.logger.error(
        `Fonio offer ${reservationId} failed after create: ${
          err instanceof Error ? err.message : err
        } — rolling back`,
      );
      await this.rollbackOffer(reservationId);
      throw new ServiceUnavailableException({
        offerCreated: false,
        message: 'Booking offer could not be completed safely',
        guestMessage: GUEST_MESSAGE_FAIL,
      });
    }
  }

  async isBookingOfferEnabled(): Promise<boolean> {
    const config = await this.prisma.verificationConfig.findFirst({
      where: { isDefault: true },
      select: { bookingOfferEnabled: true },
    });
    if (config) return config.bookingOfferEnabled;
    return this.config.get('BOOKING_OFFER_ENABLED') !== 'false';
  }

  /** Reject empty / placeholder contact so Hostaway never gets a fake confirmed booking. */
  private assertRealContact(dto: BookingOfferDto) {
    const first = dto.guestFirstName.trim();
    const last = dto.guestLastName.trim();
    const email = dto.guestEmail.trim().toLowerCase();
    const phoneDigits = dto.phone.replace(/\D/g, '');

    if (first.length < 2 || last.length < 2) {
      throw new BadRequestException({
        offerCreated: false,
        message: 'Guest first and last name are required',
        guestMessage:
          'Für ein Angebot brauche ich bitte noch Ihren Vor- und Nachnamen.',
      });
    }
    if (phoneDigits.length < 8) {
      throw new BadRequestException({
        offerCreated: false,
        message: 'A valid phone number is required',
        guestMessage:
          'Für ein Angebot brauche ich bitte noch eine gültige Telefonnummer.',
      });
    }
    if (
      /@(example\.com|test\.com|email\.com|localhost)$/i.test(email) ||
      /^(test|gast|guest|unknown|n\/a|na)([.+]|$)/i.test(email.split('@')[0] ?? '')
    ) {
      throw new BadRequestException({
        offerCreated: false,
        message: 'A real guest email is required',
        guestMessage:
          'Für ein Angebot brauche ich bitte noch Ihre E-Mail-Adresse.',
      });
    }
  }

  private async syncLocalReservation(reservationId: number) {
    await this.sync.syncSingleReservation(reservationId);
    const local = await this.prisma.reservation.findUnique({
      where: { hostawayId: reservationId },
      select: { id: true },
    });
    if (!local) {
      throw new Error(`Local sync missing for Hostaway reservation ${reservationId}`);
    }
  }

  /**
   * Fail closed: Hostaway must keep the reservation as inquiry.
   * If it created a confirmed booking, force inquiry; if that fails, cancel.
   */
  private async ensureInquiryStatus(reservationId: number) {
    const live = await this.hostaway.getReservation(reservationId);
    let status = String(live?.status || '').toLowerCase();

    if (status.startsWith('inquiry')) {
      await this.prisma.reservation
        .updateMany({
          where: { hostawayId: reservationId },
          data: { status: live.status || 'inquiry' },
        })
        .catch(() => undefined);
      return;
    }

    this.logger.warn(
      `Fonio offer ${reservationId} created as status=${live?.status}; forcing inquiry`,
    );

    try {
      await this.hostaway.updateReservation(reservationId, { status: 'inquiry' });
      const again = await this.hostaway.getReservation(reservationId);
      status = String(again?.status || '').toLowerCase();
      if (!status.startsWith('inquiry')) {
        throw new Error(`Hostaway still reports status=${again?.status}`);
      }
      await this.prisma.reservation
        .updateMany({
          where: { hostawayId: reservationId },
          data: { status: again.status || 'inquiry' },
        })
        .catch(() => undefined);
    } catch (err) {
      this.logger.error(
        `Failed to force inquiry on Fonio offer ${reservationId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      await this.rollbackOffer(reservationId);
      throw new ServiceUnavailableException({
        offerCreated: false,
        message:
          'Hostaway did not accept inquiry status; reservation was cancelled to avoid an unpaid confirmed booking',
        guestMessage: GUEST_MESSAGE_FAIL,
      });
    }
  }

  private async rollbackOffer(reservationId: number) {
    try {
      await this.hostaway.cancelReservation(reservationId);
      await this.prisma.reservation
        .updateMany({
          where: { hostawayId: reservationId },
          data: { status: 'cancelled' },
        })
        .catch(() => undefined);
      this.logger.warn(`Rolled back Fonio offer reservation ${reservationId}`);
    } catch (err) {
      this.logger.error(
        `CRITICAL: could not cancel Fonio offer ${reservationId} after failure: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  private toFinanceField(component: HostawayPriceComponent) {
    return {
      listingFeeSettingId: component.listingFeeSettingId ?? null,
      type: component.type,
      name: component.name,
      title: component.title,
      alias: component.alias ?? null,
      quantity: component.quantity ?? null,
      value: component.value,
      total: component.total,
      isIncludedInTotalPrice: component.isIncludedInTotalPrice,
      isOverriddenByUser: component.isOverriddenByUser ?? 0,
      isMandatory: component.isMandatory ?? null,
      isDeleted: component.isDeleted ?? 0,
    };
  }
}

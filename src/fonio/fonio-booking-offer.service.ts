import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GuestPaymentAutomationService } from '../automation/guest-payment-automation.service';
import { HostawayClient } from '../hostaway/hostaway.client';
import { HostawayPriceComponent } from '../hostaway/hostaway.types';
import { HostawaySyncService } from '../hostaway/hostaway-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { FonioAvailabilityService } from './fonio-availability.service';
import { BookingOfferDto } from './dto/booking-offer.dto';

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
      throw new BadRequestException('Automatic booking offers are disabled');
    }

    const listing = await this.prisma.listing.findUnique({
      where: { hostawayId: dto.listingId },
    });
    if (!listing || !listing.isBookable) {
      throw new NotFoundException('Listing not found or not bookable');
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
    await this.sync.syncSingleReservation(created.id).catch((err) => {
      this.logger.warn(
        `Offer created in Hostaway (${created.id}) but local sync failed: ${err instanceof Error ? err.message : err}`,
      );
    });

    // If Hostaway ignored status:inquiry and created a confirmed booking, force inquiry.
    const createdStatus = String(created.status || '').toLowerCase();
    if (createdStatus && !createdStatus.startsWith('inquiry')) {
      this.logger.warn(
        `Fonio offer ${created.id} created as status=${created.status}; forcing inquiry`,
      );
      try {
        await this.hostaway.updateReservation(created.id, { status: 'inquiry' });
        await this.prisma.reservation
          .updateMany({
            where: { hostawayId: created.id },
            data: { status: 'inquiry' },
          })
          .catch(() => undefined);
        created.status = 'inquiry';
      } catch (err) {
        this.logger.error(
          `Failed to force inquiry on Fonio offer ${created.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    const paymentResult = await this.guestPayments
      .requestDepositAfterFonioOffer(created.id, {
        hostNote,
        guestEmail: dto.guestEmail.trim(),
      })
      .catch((err) => {
        this.logger.warn(
          `Fonio deposit request failed for ${created.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return { ok: false, reason: 'error' as const };
      });

    if (paymentResult.ok) {
      this.logger.log(
        `Fonio deposit request sent for inquiry ${created.id} (charge ${paymentResult.chargeId ?? 'n/a'})`,
      );
    }

    return {
      offerCreated: true,
      reservationId: created.id,
      listingId: dto.listingId,
      listingName: listing.name,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      guests: dto.guests,
      totalPrice: price.totalPrice,
      currency: 'EUR',
      status: 'inquiry',
      depositRequested: paymentResult.ok === true,
      depositRequestReason: paymentResult.ok ? undefined : paymentResult.reason,
      message:
        'Booking inquiry created in Hostaway (not confirmed). Deposit request sent when possible; confirmation only after payment.',
      guestMessage:
        'Vielen Dank — Ihre Anfrage ist aufgenommen. Sie erhalten von uns ein Angebot mit Bitte um Anzahlung. Eine verbindliche Buchungsbestätigung erfolgt erst nach Zahlungseingang der Anzahlung.',
    };
  }

  async isBookingOfferEnabled(): Promise<boolean> {
    const config = await this.prisma.verificationConfig.findFirst({
      where: { isDefault: true },
      select: { bookingOfferEnabled: true },
    });
    if (config) return config.bookingOfferEnabled;
    return this.config.get('BOOKING_OFFER_ENABLED') !== 'false';
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

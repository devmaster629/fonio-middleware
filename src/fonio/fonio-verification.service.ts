import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  hashPhoneForStorage,
  hashValue,
  phonesMatch,
} from '../common/utils/crypto.util';
import { normalizeDateInput } from '../common/utils/date-input.util';
import { parseReservationIdInput } from '../common/utils/reservation-id.util';
import { listingNameMatches } from '../common/utils/listing-name-match.util';
import { HostawayClient } from '../hostaway/hostaway.client';
import { HostawaySyncService } from '../hostaway/hostaway-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { GuestVerifyDto } from './dto/guest-verify.dto';
import {
  normalizeVerificationConfigFields,
  VERIFICATION_FIELD_OPTIONS,
  VerificationField,
} from './verification-fields';

export interface VerifiedSessionPayload {
  sub: string;
  reservationHostawayId: number;
  listingHostawayId: number;
}

const FIELD_LABELS_DE: Record<VerificationField, string> = {
  stayDates: 'Anreise- und Abreisedatum',
  listingName: 'Name der Unterkunft',
  phone: 'Telefonnummer',
  email: 'E-Mail-Adresse',
  reservationId: 'Reservierungsnummer',
};

function joinLabelsDe(labels: string[]): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} oder ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} oder ${labels[labels.length - 1]}`;
}

function minMatchLabelDe(count: number): string {
  if (count === 1) return 'mindestens eine weitere Angabe';
  return `mindestens ${count} weitere Angaben`;
}

function additionalMinMatch(totalMinMatch: number): number {
  return Math.max(0, totalMinMatch - 1);
}

@Injectable()
export class FonioVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly hostaway: HostawayClient,
    private readonly sync: HostawaySyncService,
  ) {}

  async getRequirements() {
    const config = await this.prisma.verificationConfig.findFirst({
      where: { isDefault: true },
    });
    const scoringFields = this.getScoringFields(config?.requiredFields);
    const minMatch = Math.min(
      config?.minMatchCount ?? 3,
      scoringFields.length,
    );
    const optionalFields = scoringFields.filter((f) => f !== 'stayDates');
    const optionalFieldLabelsDe = optionalFields.map((f) => FIELD_LABELS_DE[f]);
    const optionalFieldsListDe = joinLabelsDe(optionalFieldLabelsDe);
    const additionalMinMatchCount = additionalMinMatch(minMatch);
    const hintDe = this.buildHintDe(minMatch, optionalFields);
    const guestScriptDe = this.buildGuestScriptDe(
      additionalMinMatchCount,
      optionalFieldLabelsDe,
    );
    const verificationInstructionsDe = this.buildVerificationInstructionsDe({
      minMatch,
      additionalMinMatchCount,
      optionalFieldsListDe,
      hintDe,
      guestScriptDe,
      bookingOfferEnabled: config?.bookingOfferEnabled ?? true,
    });

    return {
      alwaysRequired: ['stayDates'],
      optionalFields,
      optionalFieldLabelsDe,
      optionalFieldsListDe,
      minMatchCount: minMatch,
      additionalMinMatchCount,
      bookingOfferEnabled: config?.bookingOfferEnabled ?? true,
      hintDe,
      guestScriptDe,
      verificationInstructionsDe,
      hintEn:
        'Arrival and departure dates always count as one match. Provide at least ' +
        `${additionalMinMatchCount} more matching detail(s) from: ${optionalFieldsListDe || 'configured fields'} ` +
        `(${minMatch} total matches required). The guest does not need to provide all fields.`,
      postVerifyHintDe:
        'Nach erfolgreicher Verifizierung: verificationToken für Buchung abrufen und Gästeanfrage verwenden. ' +
        'Nicht erneut nach Name fragen — Name steht in der Buchung (guestNameHint).',
    };
  }

  async verify(dto: GuestVerifyDto) {
    this.assertStayDatesProvided(dto);
    const hint = (await this.getRequirements()).hintDe;

    const reservation = await this.findReservation(dto);
    if (!reservation) {
      throw new UnauthorizedException({
        verified: false,
        message: 'Reservation not found',
        hint:
          (await this.getRequirements()).hintDe +
          ' Hinweis: Booking.com-Bestätigungsnummern sind oft nicht die Hostaway-Reservierungsnummer — Telefon oder E-Mail zur Buchung helfen.',
      });
    }

    const resolved = reservation;

    const config = await this.prisma.verificationConfig.findFirst({
      where: { isDefault: true },
    });

    const scoringFields = this.getScoringFields(config?.requiredFields);
    const minMatch = Math.min(
      config?.minMatchCount ?? 3,
      scoringFields.length,
    );

    const checks: VerificationField[] = [];
    let matches = 0;

    for (const field of scoringFields) {
      const matched = await this.fieldMatches(field, dto, resolved);
      if (matched) {
        matches++;
        checks.push(field);
      }
    }

    if (matches < minMatch) {
      const missing = scoringFields.filter((f) => !checks.includes(f));
      const failure = this.buildVerifyFailureDetails(
        checks,
        missing,
        minMatch,
        matches,
      );
      throw new UnauthorizedException({
        verified: false,
        message: 'Guest verification failed',
        matchedFields: checks,
        missingFields: missing,
        requiredMinMatches: minMatch,
        stillNeedCount: failure.stillNeedCount,
        whatToAskDe: failure.whatToAskDe,
        reservationId: resolved.hostawayId,
        hint: failure.whatToAskDe || hint,
      });
    }

    const token = await this.jwt.signAsync({
      sub: resolved.id,
      reservationHostawayId: resolved.hostawayId,
      listingHostawayId: resolved.listing.hostawayId,
    } satisfies VerifiedSessionPayload);

    return {
      verified: true,
      verificationToken: token,
      matchedFields: checks,
      hint,
      guestNameHint: resolved.guestNameMasked,
      guestFirstNameHint: resolved.guestFirstNameHint,
      postVerifyHintDe:
        'Verifizierung abgeschlossen. Name und Buchungsdaten liegen vor — nicht erneut nach dem Namen fragen. ' +
        'verificationToken aus dieser Antwort für „Buchung abrufen“ und „Gästeanfrage“ mitschicken.',
      reservation: {
        id: resolved.hostawayId,
        arrivalDate: resolved.arrivalDate.toISOString().slice(0, 10),
        departureDate: resolved.departureDate.toISOString().slice(0, 10),
        guests: resolved.numberOfGuests,
        listingName: resolved.listing.name,
        listingCity: resolved.listing.city,
        status: resolved.status,
        guestNameHint: resolved.guestNameMasked,
        guestFirstNameHint: resolved.guestFirstNameHint,
      },
    };
  }

  async assertVerified(token: string, reservationHostawayId: number) {
    if (!token?.trim()) {
      throw new UnauthorizedException({
        message: 'Verification token required',
        hintDe:
          'Bitte zuerst „Gast verifizieren“ aufrufen und verificationToken aus der Antwort bei „Gästeanfrage“, „Buchung abrufen“ oder „Anreiseinfos senden“ mitschicken.',
        fonioHint:
          'Call POST guest/verify first, then pass verificationToken to guest/requests, guest/reservation, and guest/send-checkin-info.',
      });
    }

    let payload: VerifiedSessionPayload;
    try {
      payload = await this.jwt.verifyAsync<VerifiedSessionPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired verification token');
    }

    if (payload.reservationHostawayId !== reservationHostawayId) {
      throw new UnauthorizedException('Token does not match reservation');
    }

    return payload;
  }

  async getSafeReservation(reservationHostawayId: number, token: string) {
    await this.assertVerified(token, reservationHostawayId);

    let reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId: reservationHostawayId },
      include: { listing: true },
    });

    if (!reservation) {
      reservation = await this.sync.syncSingleReservation(reservationHostawayId);
    }

    if (!reservation) {
      throw new NotFoundException('Reservation not found');
    }

    return {
      id: reservation.hostawayId,
      arrivalDate: reservation.arrivalDate.toISOString().slice(0, 10),
      departureDate: reservation.departureDate.toISOString().slice(0, 10),
      guests: reservation.numberOfGuests,
      listingName: reservation.listing.name,
      listingCity: reservation.listing.city,
      status: reservation.status,
      guestNameHint: reservation.guestNameMasked,
      guestFirstNameHint: reservation.guestFirstNameHint,
    };
  }

  private getScoringFields(configFields?: string[]): VerificationField[] {
    const normalized = normalizeVerificationConfigFields(
      configFields ?? [
        'stayDates',
        'listingName',
        'phone',
        'email',
        'reservationId',
      ],
    );
    return normalized.length > 0
      ? normalized
      : [...VERIFICATION_FIELD_OPTIONS];
  }

  private buildHintDe(
    minMatch: number,
    optionalFields: VerificationField[],
  ): string {
    const labels = optionalFields.map((f) => FIELD_LABELS_DE[f]);
    const extra = additionalMinMatch(minMatch);
    if (labels.length === 0) {
      return 'Anreise- und Abreisedatum sind immer erforderlich.';
    }
    return (
      'Anreise- und Abreisedatum zählen als eine Angabe. Zusätzlich ' +
      `${minMatchLabelDe(extra)} aus: ${joinLabelsDe(labels)} ` +
      `(insgesamt ${minMatch} Treffer). ` +
      'Der Gast muss nicht alles nennen — nur genug zur Bestätigung der Buchung.'
    );
  }

  private buildGuestScriptDe(
    additionalMinMatchCount: number,
    optionalLabels: string[],
  ): string {
    if (optionalLabels.length === 0) {
      return 'Zur Bestätigung brauche ich bitte Ihr An- und Abreisedatum.';
    }
    if (additionalMinMatchCount === 0) {
      return 'Zur Bestätigung brauche ich bitte Ihr An- und Abreisedatum.';
    }
    return (
      'Zur Bestätigung brauche ich Ihr An- und Abreisedatum sowie ' +
      `${minMatchLabelDe(additionalMinMatchCount)} — zum Beispiel ${joinLabelsDe(optionalLabels)}. ` +
      'Sie müssen nicht alles nennen.'
    );
  }

  private buildVerificationInstructionsDe(params: {
    minMatch: number;
    additionalMinMatchCount: number;
    optionalFieldsListDe: string;
    hintDe: string;
    guestScriptDe: string;
    bookingOfferEnabled: boolean;
  }): string {
    const bookingOfferLine = params.bookingOfferEnabled
      ? '- Automatisches Buchungsangebot ist aktiv (booking-offer API).'
      : '- Automatisches Buchungsangebot ist deaktiviert — nur Verfügbarkeit prüfen, kein booking-offer.';

    return [
      '# Verifizierung bestehender Buchung (aus Admin-Einstellungen, live)',
      `Regel: ${params.hintDe}`,
      `Sage dem Gast in etwa: „${params.guestScriptDe}"`,
      `- An- und Abreisedatum zählen als 1 Treffer; insgesamt ${params.minMatch} Treffer nötig (also noch ${params.additionalMinMatchCount} weitere Angabe(n) nach den Daten).`,
      params.optionalFieldsListDe
        ? `- Erlaubte Zusatzangaben (Either/Or): ${params.optionalFieldsListDe}`
        : '- Keine weiteren Zusatzfelder in Admin aktiviert — nur An- und Abreisedatum.',
      '- Alle bereits genannten Angaben in EINEM Aufruf von „Gast verifizieren“ mitschicken (nicht nur die letzte Antwort).',
      '- Frage NICHT der Reihe nach nach allen Feldern. Sammle, was der Gast nennt, dann Tool „Gast verifizieren“.',
      '- Bei Fehlschlag: whatToAskDe oder hint aus der API — nur fehlende Angaben nachfragen.',
      '- Nach Erfolg: verificationToken speichern; für Gästeanfrage und Buchung abrufen verwenden. Nicht erneut nach Name fragen.',
      '- Erkannter Anrufer oder Vorname allein reichen NICHT.',
      bookingOfferLine,
    ].join('\n');
  }

  private buildVerifyFailureDetails(
    matched: VerificationField[],
    missing: VerificationField[],
    minMatch: number,
    matchCount: number,
  ) {
    const stillNeedCount = Math.max(0, minMatch - matchCount);
    const optionalMissing = missing.filter((f) => f !== 'stayDates');
    const askLabels = optionalMissing
      .slice(0, stillNeedCount)
      .map((f) => FIELD_LABELS_DE[f]);
    const matchedLabels = matched.map((f) => FIELD_LABELS_DE[f]);

    let whatToAskDe: string;
    if (stillNeedCount <= 0) {
      whatToAskDe =
        'Die Angaben reichen noch nicht — bitte prüfen, ob alle bereits genannten Daten im API-Aufruf mitgeschickt wurden.';
    } else if (askLabels.length === 1) {
      whatToAskDe =
        `Noch ${stillNeedCount} Angabe fehlt — bitte nachfragen: ${askLabels[0]}. ` +
        `Bereits bestätigt: ${matchedLabels.join(', ') || 'keine'}.`;
    } else {
      whatToAskDe =
        `Noch ${stillNeedCount} Angabe(n) fehlen — z. B. ${joinLabelsDe(askLabels)}. ` +
        `Bereits bestätigt: ${matchedLabels.join(', ') || 'keine'}. ` +
        'Alle bisher genannten Daten im nächsten Verifizierungsaufruf mitschicken.';
    }

    return { stillNeedCount, whatToAskDe };
  }

  private assertStayDatesProvided(dto: GuestVerifyDto) {
    if (!dto.arrivalDate?.trim() || !dto.departureDate?.trim()) {
      throw new UnauthorizedException({
        verified: false,
        message: 'Arrival and departure dates are required',
        missingFields: ['stayDates'],
        hint: 'Bitte Anreise- und Abreisedatum erfragen (z. B. 08.08.2026 und 10.08.2026).',
      });
    }
  }

  private async findReservation(dto: GuestVerifyDto) {
    const hostawayId = parseReservationIdInput(dto.reservationId);
    if (hostawayId) {
      let reservation = await this.prisma.reservation.findUnique({
        where: { hostawayId },
        include: { listing: true },
      });
      if (!reservation) {
        reservation = await this.sync.syncSingleReservation(hostawayId);
      }
      if (reservation) return reservation;
    }

    const arrival = this.parseDateOnly(dto.arrivalDate);
    const departure = this.parseDateOnly(dto.departureDate);

    let candidates = await this.prisma.reservation.findMany({
      where: { arrivalDate: arrival, departureDate: departure },
      include: { listing: true },
    });

    if (candidates.length === 0) {
      await this.sync.syncReservationsForStayDates(arrival, departure);
      candidates = await this.prisma.reservation.findMany({
        where: { arrivalDate: arrival, departureDate: departure },
        include: { listing: true },
      });
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const narrowed = await this.narrowCandidates(dto, candidates);
    if (narrowed.length === 1) return narrowed[0];
    if (narrowed.length === 0) return null;

    throw new UnauthorizedException({
      verified: false,
      message: 'Multiple bookings match — please provide more details',
      ambiguousCount: narrowed.length,
      hint: (await this.getRequirements()).hintDe,
    });
  }

  private async narrowCandidates(
    dto: GuestVerifyDto,
    candidates: NonNullable<
      Awaited<
        ReturnType<
          typeof this.prisma.reservation.findMany<{
            include: { listing: true };
          }>
        >
      >
    >[number][],
  ) {
    let pool = [...candidates];

    if (dto.listingName?.trim()) {
      const byListing = pool.filter((r) =>
        listingNameMatches(dto.listingName!, r.listing),
      );
      if (byListing.length > 0) pool = byListing;
    }

    if (dto.phone?.trim()) {
      const byPhone: typeof pool = [];
      for (const r of pool) {
        if (await this.verifyPhone(dto.phone, r)) byPhone.push(r);
      }
      if (byPhone.length > 0) pool = byPhone;
    }

    if (dto.email?.trim()) {
      const byEmail: typeof pool = [];
      for (const r of pool) {
        if (await this.verifyEmail(dto.email, r)) byEmail.push(r);
      }
      if (byEmail.length > 0) pool = byEmail;
    }

    return pool;
  }

  private parseDateOnly(value: string): Date {
    const normalized = normalizeDateInput(value) ?? value;
    const [y, m, d] = normalized.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  private async fieldMatches(
    field: VerificationField,
    dto: GuestVerifyDto,
    reservation: {
      guestPhone: string | null;
      phoneHash: string | null;
      guestEmail: string | null;
      emailHash: string | null;
      arrivalDate: Date;
      departureDate: Date;
      listing: { name: string; aliases?: string[] };
      hostawayId: number;
    },
  ): Promise<boolean> {
    switch (field) {
      case 'stayDates': {
        const arrival =
          normalizeDateInput(dto.arrivalDate) ?? dto.arrivalDate;
        const departure =
          normalizeDateInput(dto.departureDate) ?? dto.departureDate;
        return (
          arrival === reservation.arrivalDate.toISOString().slice(0, 10) &&
          departure === reservation.departureDate.toISOString().slice(0, 10)
        );
      }
      case 'reservationId':
        return (
          dto.reservationId !== undefined &&
          dto.reservationId === reservation.hostawayId
        );
      case 'phone':
        return dto.phone
          ? await this.verifyPhone(dto.phone, reservation)
          : false;
      case 'email':
        return dto.email
          ? await this.verifyEmail(dto.email, reservation)
          : false;
      case 'listingName': {
        if (!dto.listingName) return false;
        return listingNameMatches(dto.listingName, reservation.listing);
      }
      default:
        return false;
    }
  }

  private async verifyPhone(
    phone: string,
    reservation: {
      guestPhone: string | null;
      phoneHash: string | null;
      hostawayId: number;
    },
  ): Promise<boolean> {
    if (reservation.guestPhone && phonesMatch(phone, reservation.guestPhone)) {
      return true;
    }
    if (
      reservation.phoneHash &&
      hashPhoneForStorage(phone) === reservation.phoneHash
    ) {
      return true;
    }
    const remote = await this.hostaway.getReservation(reservation.hostawayId);
    return Boolean(remote.phone && phonesMatch(phone, remote.phone));
  }

  private async verifyEmail(
    email: string,
    reservation: {
      guestEmail: string | null;
      emailHash: string | null;
      hostawayId: number;
    },
  ): Promise<boolean> {
    if (
      reservation.guestEmail &&
      email.toLowerCase() === reservation.guestEmail.toLowerCase()
    ) {
      return true;
    }
    if (reservation.emailHash && hashValue(email) === reservation.emailHash) {
      return true;
    }
    const remote = await this.hostaway.getReservation(reservation.hostawayId);
    if (
      remote.guestEmail &&
      hashValue(email) === hashValue(remote.guestEmail)
    ) {
      return true;
    }
    return false;
  }

  static getFieldOptions() {
    return VERIFICATION_FIELD_OPTIONS;
  }
}

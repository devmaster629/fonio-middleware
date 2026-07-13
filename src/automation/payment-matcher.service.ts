import { Injectable } from '@nestjs/common';
import { PaymentMatchDecision } from '@prisma/client';
import { hashValue } from '../common/utils/crypto.util';
import { listingNameMatches } from '../common/utils/listing-name-match.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  NormalizedExternalPayment,
  PAYMENT_AMBIGUITY_SCORE_GAP,
  PAYMENT_AUTO_MATCH_MIN_SCORE,
  PaymentMatchCandidate,
  PaymentMatchResult,
} from './automation.types';

@Injectable()
export class PaymentMatcherService {
  constructor(private readonly prisma: PrismaService) {}

  async match(payment: NormalizedExternalPayment): Promise<PaymentMatchResult> {
    if (payment.amount <= 0) {
      return {
        decision: PaymentMatchDecision.REFUND,
        candidates: [],
        reason: 'Negative or zero amount — refunds are not auto-processed',
      };
    }

    if (payment.amount > 50_000) {
      return {
        decision: PaymentMatchDecision.BULK_PAYMENT,
        candidates: [],
        reason: 'Amount exceeds bulk-payment safety threshold',
      };
    }

    const reservations = await this.loadCandidateReservations();
    const referenceText = this.combineReferenceText(payment);
    const reservationIdsInReference = this.extractReservationIds(referenceText);

    const candidates = reservations
      .map((reservation) =>
        this.scoreReservation(reservation, payment, referenceText, reservationIdsInReference),
      )
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      return {
        decision: PaymentMatchDecision.NO_MATCH,
        candidates: [],
        reason: 'No reservation matched the payment signals',
      };
    }

    const best = candidates[0];
    const second = candidates[1];
    const hasStrongIdMatch = reservationIdsInReference.includes(best.hostawayId);

    if (
      second &&
      best.score - second.score < PAYMENT_AMBIGUITY_SCORE_GAP &&
      !hasStrongIdMatch
    ) {
      return {
        decision: PaymentMatchDecision.AMBIGUOUS,
        candidates: candidates.slice(0, 5),
        best,
        reason: `Multiple close matches (${best.hostawayId} vs ${second.hostawayId})`,
      };
    }

    if (hasStrongIdMatch && candidates.length > 1 && !second) {
      // single id match path continues below
    } else if (
      hasStrongIdMatch &&
      candidates.length > 1 &&
      second &&
      reservationIdsInReference.includes(second.hostawayId)
    ) {
      return {
        decision: PaymentMatchDecision.AMBIGUOUS,
        candidates: candidates.slice(0, 5),
        best,
        reason: 'Multiple reservation numbers found in payment reference',
      };
    }

    if (best.score < PAYMENT_AUTO_MATCH_MIN_SCORE && !hasStrongIdMatch) {
      return {
        decision: PaymentMatchDecision.PARTIAL_UNCLEAR,
        candidates: candidates.slice(0, 5),
        best,
        reason: `Best match score ${best.score} is below auto-apply threshold`,
      };
    }

    if (!hasStrongIdMatch && best.score < PAYMENT_AUTO_MATCH_MIN_SCORE) {
      return {
        decision: PaymentMatchDecision.PARTIAL_UNCLEAR,
        candidates: candidates.slice(0, 5),
        best,
        reason: 'Match confidence too low for automatic processing',
      };
    }

    return {
      decision: PaymentMatchDecision.UNAMBIGUOUS,
      candidates: [best],
      best,
      reason: best.reasons.join('; '),
    };
  }

  private async loadCandidateReservations() {
    const lookback = new Date();
    lookback.setDate(lookback.getDate() - 30);
    const lookahead = new Date();
    lookahead.setDate(lookahead.getDate() + 365);

    return this.prisma.reservation.findMany({
      where: {
        departureDate: { gte: lookback },
        arrivalDate: { lte: lookahead },
        status: { notIn: ['cancelled', 'declined', 'expired'] },
      },
      include: { listing: true },
      take: 500,
      orderBy: { arrivalDate: 'asc' },
    });
  }

  private scoreReservation(
    reservation: {
      id: string;
      hostawayId: number;
      guestName: string | null;
      guestEmail: string | null;
      arrivalDate: Date;
      departureDate: Date;
      listing: { name: string; aliases: string[] };
    },
    payment: NormalizedExternalPayment,
    referenceText: string,
    reservationIdsInReference: number[],
  ): PaymentMatchCandidate {
    const reasons: string[] = [];
    let score = 0;

    if (reservationIdsInReference.includes(reservation.hostawayId)) {
      score += 55;
      reasons.push(`Reservation #${reservation.hostawayId} in reference`);
    }

    if (payment.payerEmail && reservation.guestEmail) {
      const payer = payment.payerEmail.trim().toLowerCase();
      const guest = reservation.guestEmail.trim().toLowerCase();
      if (payer === guest || hashValue(payer) === hashValue(guest)) {
        score += 30;
        reasons.push('Guest email matches');
      }
    }

    if (payment.payerName && reservation.guestName) {
      if (this.namesMatch(payment.payerName, reservation.guestName)) {
        score += 25;
        reasons.push('Guest name matches');
      }
    }

    if (referenceText && reservation.guestName) {
      const guestNorm = this.normalizeName(reservation.guestName);
      if (guestNorm.length >= 4 && referenceText.includes(guestNorm)) {
        score += 15;
        reasons.push('Guest name appears in reference');
      }
    }

    if (
      referenceText &&
      listingNameMatches(referenceText, {
        name: reservation.listing.name,
        aliases: reservation.listing.aliases,
      })
    ) {
      score += 15;
      reasons.push('Listing name appears in reference');
    }

    if (this.datesAppearInReference(referenceText, reservation)) {
      score += 10;
      reasons.push('Stay dates appear in reference');
    }

    const amountScore = this.scoreAmount(payment.amount, referenceText);
    if (amountScore > 0) {
      score += amountScore;
      reasons.push('Payment amount aligns with reference');
    }

    return {
      reservationId: reservation.id,
      hostawayId: reservation.hostawayId,
      guestName: reservation.guestName,
      listingName: reservation.listing.name,
      arrivalDate: reservation.arrivalDate.toISOString().slice(0, 10),
      departureDate: reservation.departureDate.toISOString().slice(0, 10),
      score,
      reasons,
    };
  }

  private scoreAmount(amount: number, referenceText: string): number {
    const normalizedAmount = amount.toFixed(2);
    const compact = normalizedAmount.replace('.00', '');
    if (
      referenceText.includes(normalizedAmount) ||
      referenceText.includes(compact) ||
      referenceText.includes(normalizedAmount.replace('.', ','))
    ) {
      return 20;
    }
    return 0;
  }

  private combineReferenceText(payment: NormalizedExternalPayment): string {
    return [payment.reference, payment.payerName]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '');
  }

  private extractReservationIds(text: string): number[] {
    const ids = new Set<number>();
    const patterns = [
      /\bres(?:ervierung|ervation)?\s*#?\s*(\d{6,9})\b/gi,
      /\b(?:buchung|booking)\s*#?\s*(\d{6,9})\b/gi,
      /\bhostaway\s*#?\s*(\d{6,9})\b/gi,
      /\b(\d{7,8})\b/g,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const id = Number(match[1]);
        if (Number.isFinite(id) && id >= 1_000_000) ids.add(id);
      }
    }
    return [...ids];
  }

  private namesMatch(a: string, b: string): boolean {
    const tokensA = new Set(this.normalizeName(a).split(/\s+/).filter((t) => t.length >= 3));
    const tokensB = new Set(this.normalizeName(b).split(/\s+/).filter((t) => t.length >= 3));
    if (tokensA.size === 0 || tokensB.size === 0) return false;
    let overlap = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) overlap += 1;
    }
    return overlap >= 1 && overlap >= Math.min(tokensA.size, tokensB.size);
  }

  private normalizeName(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private datesAppearInReference(
    referenceText: string,
    reservation: { arrivalDate: Date; departureDate: Date },
  ): boolean {
    const arrival = reservation.arrivalDate.toISOString().slice(0, 10);
    const departure = reservation.departureDate.toISOString().slice(0, 10);
    const variants = [
      arrival,
      departure,
      arrival.split('-').reverse().join('.'),
      departure.split('-').reverse().join('.'),
    ];
    return variants.some((variant) => referenceText.includes(variant));
  }
}

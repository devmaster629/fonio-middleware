import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMatchDecision } from '@prisma/client';
import { hashValue } from '../common/utils/crypto.util';
import { listingNameMatches } from '../common/utils/listing-name-match.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  NormalizedExternalPayment,
  PAYMENT_AMBIGUITY_SCORE_GAP,
  PAYMENT_AUTO_MATCH_MIN_SCORE,
  PAYMENT_EXCLUDED_RESERVATION_STATUSES,
  PaymentMatchCandidate,
  PaymentMatchResult,
  isOtaPaymentChannel,
} from './automation.types';
import { detectCombinedDepositHint } from './payment-split-hint.util';

@Injectable()
export class PaymentMatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config?: ConfigService,
  ) {}

  async match(payment: NormalizedExternalPayment): Promise<PaymentMatchResult> {
    const payoutSender = this.detectPlatformPayout(payment);
    if (payoutSender) {
      return {
        decision: PaymentMatchDecision.PLATFORM_PAYOUT,
        candidates: [],
        reason: `Channel payout from "${payoutSender}" — guest already paid via the platform`,
      };
    }

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
      .filter((candidate) => {
        if (candidate.score <= 0) return false;
        // Guest bank/PayPal payments are never assigned to portal-collected stays
        // (Booking.com, Airbnb, …). Exception: reservation # is in the bank reference.
        if (
          isOtaPaymentChannel(candidate.channelName) &&
          !reservationIdsInReference.includes(candidate.hostawayId)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Prefer direct / non-OTA when scores are equal
        const aOta = isOtaPaymentChannel(a.channelName) ? 1 : 0;
        const bOta = isOtaPaymentChannel(b.channelName) ? 1 : 0;
        return aOta - bOta;
      });

    if (candidates.length === 0) {
      return {
        decision: PaymentMatchDecision.NO_MATCH,
        candidates: [],
        reason:
          'No booking could be matched from the payer name, reference text, amount, or reservation number',
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
        reason: this.explainAmbiguous(best, second, payment),
      };
    }

    if (
      hasStrongIdMatch &&
      candidates.length > 1 &&
      second &&
      reservationIdsInReference.includes(second.hostawayId)
    ) {
      return {
        decision: PaymentMatchDecision.AMBIGUOUS,
        candidates: candidates.slice(0, 5),
        best,
        reason:
          `The bank reference contains more than one reservation number (#${best.hostawayId} and #${second.hostawayId}). Please choose the correct booking.`,
      };
    }

    const combinedHint = detectCombinedDepositHint(
      payment.amount,
      candidates.slice(0, 5),
    );
    if (combinedHint && !hasStrongIdMatch) {
      return {
        decision: PaymentMatchDecision.AMBIGUOUS,
        candidates: candidates.slice(0, 5),
        best,
        reason: combinedHint.reason,
      };
    }

    if (this.canAutoApply(best, second, hasStrongIdMatch)) {
      return {
        decision: PaymentMatchDecision.UNAMBIGUOUS,
        candidates: [best],
        best,
        reason: best.reasons.join('; '),
      };
    }

    return {
      decision: PaymentMatchDecision.PARTIAL_UNCLEAR,
      candidates: candidates.slice(0, 5),
      best,
      reason: this.explainPartialMatch(best, payment),
    };
  }

  /**
   * Auto-apply only when the match is clear.
   * Ambiguous / name-only / weak amount evidence still go to review.
   */
  private canAutoApply(
    best: PaymentMatchCandidate,
    second: PaymentMatchCandidate | undefined,
    hasStrongIdMatch: boolean,
  ): boolean {
    if (hasStrongIdMatch) return true;
    if (best.score >= PAYMENT_AUTO_MATCH_MIN_SCORE) return true;

    const reasons = best.reasons.join(' ').toLowerCase();
    const strongGuest =
      reasons.includes('guest name matches') ||
      reasons.includes('guest email matches');
    const strongAmount =
      reasons.includes('equals outstanding balance') ||
      reasons.includes('equals reservation total') ||
      reasons.includes('deposit/installment') ||
      reasons.includes('appears in reservation notes') ||
      reasons.includes('payment amount aligns');
    // Restzahlung/Teilzahlung + guest boosts ranking for review, but partial
    // open-balance fits alone are not enough to auto-apply.
    const clearlyUnique =
      !second || best.score - second.score >= PAYMENT_AMBIGUITY_SCORE_GAP;

    // Unique guest + clear amount evidence (deposit in notes, balance, total, …)
    return clearlyUnique && strongGuest && strongAmount && best.score >= 55;
  }

  /**
   * Plain-language explanation for reviewers (no internal scores).
   */
  private explainPartialMatch(
    best: PaymentMatchCandidate,
    payment: NormalizedExternalPayment,
  ): string {
    const found = best.reasons.length
      ? `Matched on: ${best.reasons.join('; ')}`
      : 'Only a weak match was found';
    const missing = this.missingAutoApplySignals(best, payment);
    const missingText = missing.length
      ? ` Not enough for automatic booking because: ${missing.join('; ')}`
      : ' Additional confirmation is still required before booking this payment automatically';
    return `${found}.${missingText}.`;
  }

  private explainAmbiguous(
    best: PaymentMatchCandidate,
    second: PaymentMatchCandidate,
    payment: NormalizedExternalPayment,
  ): string {
    const bestBits = best.reasons.length ? best.reasons.join(', ') : 'name similarity';
    const secondBits = second.reasons.length
      ? second.reasons.join(', ')
      : 'name similarity';
    const amountNote =
      best.balanceDue != null &&
      !this.amountsMatch(payment.amount, best.balanceDue) &&
      !(best.totalPrice != null && this.amountsMatch(payment.amount, best.totalPrice))
        ? ` The payment amount (${payment.amount.toFixed(2)} ${payment.currency}) also does not uniquely match a booking total or outstanding balance.`
        : '';
    return (
      `Several bookings look similarly likely: #${best.hostawayId}` +
      `${best.guestName ? ` (${best.guestName})` : ''} vs #${second.hostawayId}` +
      `${second.guestName ? ` (${second.guestName})` : ''}.` +
      ` First suggestion matched on ${bestBits}; second on ${secondBits}.` +
      `${amountNote} Please choose the correct reservation.`
    );
  }

  private missingAutoApplySignals(
    best: PaymentMatchCandidate,
    payment: NormalizedExternalPayment,
  ): string[] {
    const reasons = best.reasons.join(' ').toLowerCase();
    const missing: string[] = [];

    if (!/reservation #\d+/.test(reasons)) {
      missing.push('no reservation number in the bank reference');
    }
    if (!reasons.includes('email')) {
      missing.push('no matching guest email');
    }

    const amountMatches =
      reasons.includes('equals outstanding balance') ||
      reasons.includes('equals reservation total') ||
      /deposit\/installment share/.test(reasons) ||
      reasons.includes('payment amount aligns') ||
      reasons.includes('appears in reservation notes');
    if (!amountMatches) {
      const amountLabel = `${payment.amount.toFixed(2)} ${payment.currency}`;
      if (best.balanceDue != null && best.totalPrice != null) {
        missing.push(
          `payment amount (${amountLabel}) does not match the booking total (${best.totalPrice.toFixed(2)}) or outstanding balance (${best.balanceDue.toFixed(2)})`,
        );
      } else if (best.totalPrice != null) {
        missing.push(
          `payment amount (${amountLabel}) does not match the booking total (${best.totalPrice.toFixed(2)})`,
        );
      } else {
        missing.push(
          `payment amount (${amountLabel}) could not be confirmed against the booking total`,
        );
      }
    }

    if (!reasons.includes('listing name')) {
      missing.push('listing/property name not found in the reference');
    }
    if (!reasons.includes('stay dates')) {
      missing.push('stay dates not found in the reference');
    }

    return missing;
  }

  private async loadCandidateReservations() {
    const lookback = new Date();
    lookback.setDate(lookback.getDate() - 30);
    // Include far-ahead prepaid stays (payments often arrive 1–2+ years early).
    const lookahead = new Date();
    lookahead.setDate(lookahead.getDate() + 730);

    return this.prisma.reservation.findMany({
      where: {
        departureDate: { gte: lookback },
        arrivalDate: { lte: lookahead },
        // Inquiry statuses are quotes only — never suggest or auto-match them.
        status: { notIn: [...PAYMENT_EXCLUDED_RESERVATION_STATUSES] },
      },
      include: { listing: true, notifiedCharges: true },
      take: 2000,
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
      totalPrice: number | null;
      channelName: string | null;
      hostNote: string | null;
      guestNote: string | null;
      comment: string | null;
      listing: {
        name: string;
        aliases: string[];
        roomType?: string | null;
        rawMetadata?: unknown;
      };
      notifiedCharges: { amount: number }[];
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

    const guestMatched =
      (!!payment.payerName &&
        !!reservation.guestName &&
        this.namesMatch(payment.payerName, reservation.guestName)) ||
      reasons.some((r) => r.includes('Guest name'));

    if (
      referenceText &&
      listingNameMatches(referenceText, {
        name: reservation.listing.name,
        aliases: reservation.listing.aliases,
      })
    ) {
      // Listing-only is weak evidence; require guest/email context for full weight.
      const listingPoints = guestMatched || reasons.some((r) => r.includes('email')) ? 15 : 6;
      score += listingPoints;
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

    const balanceScore = this.scoreBalanceDue(
      payment.amount,
      reservation,
      payment,
      referenceText,
    );
    if (balanceScore.score > 0) {
      score += balanceScore.score;
      reasons.push(balanceScore.reason);
    }

    const notesScore = this.scoreReservationNotes(payment.amount, reservation);
    if (notesScore.score > 0) {
      score += notesScore.score;
      reasons.push(notesScore.reason);
    }

    const totalPrice =
      reservation.totalPrice != null && Number.isFinite(reservation.totalPrice)
        ? reservation.totalPrice
        : null;
    const paid = (reservation.notifiedCharges ?? []).reduce(
      (sum, charge) => sum + (Number(charge.amount) || 0),
      0,
    );
    const balanceDue =
      totalPrice != null ? Math.max(0, Math.round((totalPrice - paid) * 100) / 100) : null;
    const hostNote = reservation.hostNote?.trim() || null;
    const listingMeta =
      reservation.listing.rawMetadata &&
      typeof reservation.listing.rawMetadata === 'object'
        ? (reservation.listing.rawMetadata as Record<string, unknown>)
        : null;
    let listingCoverUrl: string | null = null;
    if (listingMeta) {
      listingCoverUrl =
        (typeof listingMeta.coverImageUrl === 'string' && listingMeta.coverImageUrl) ||
        (typeof listingMeta.thumbnailUrl === 'string' && listingMeta.thumbnailUrl) ||
        (typeof listingMeta.pictureUrl === 'string' && listingMeta.pictureUrl) ||
        null;
      if (!listingCoverUrl) {
        const images = (listingMeta.listingImages || listingMeta.images) as
          | Array<{ url?: string; thumbnailUrl?: string }>
          | undefined;
        if (Array.isArray(images) && images[0]) {
          listingCoverUrl = images[0].url || images[0].thumbnailUrl || null;
        }
      }
    }

    return {
      reservationId: reservation.id,
      hostawayId: reservation.hostawayId,
      guestName: reservation.guestName,
      listingName: reservation.listing.name,
      listingRoomType: reservation.listing.roomType ?? null,
      listingCoverUrl,
      arrivalDate: reservation.arrivalDate.toISOString().slice(0, 10),
      departureDate: reservation.departureDate.toISOString().slice(0, 10),
      channelName: reservation.channelName ?? null,
      hostNote: hostNote ? hostNote.slice(0, 280) : null,
      totalPrice,
      balanceDue,
      score,
      reasons,
    };
  }

  /**
   * Channel payouts (Airbnb, optionally Booking.com) are aggregated transfers
   * from the platform itself — the guest already paid there, so applying them
   * as guest payments would double-count. Detection is by payer name only, so
   * direct guest payments are never affected.
   */
  private detectPlatformPayout(payment: NormalizedExternalPayment): string | null {
    const payer = (payment.payerName ?? '').toLowerCase();
    if (!payer) return null;
    const configured = this.config?.get<string>('PAYMENT_PLATFORM_PAYOUT_SENDERS');
    const patterns = (configured ?? 'airbnb')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    for (const pattern of patterns) {
      if (payer.includes(pattern)) return payment.payerName ?? pattern;
    }
    return null;
  }

  /**
   * Compare the payment amount against the reservation total and its
   * outstanding balance (total minus paid charges we already recorded).
   */
  private scoreBalanceDue(
    amount: number,
    reservation: {
      totalPrice: number | null;
      notifiedCharges: { amount: number }[];
      guestName?: string | null;
    },
    payment?: NormalizedExternalPayment,
    referenceText = '',
  ): { score: number; reason: string } {
    const total = reservation.totalPrice;
    if (!total || total <= 0) return { score: 0, reason: '' };

    const paid = reservation.notifiedCharges.reduce(
      (sum, charge) => sum + (charge.amount > 0 ? charge.amount : 0),
      0,
    );
    const balanceDue = Math.max(0, total - paid);
    const partiallyPaid = paid >= 1;
    const remainingPaymentHint = this.referenceLooksLikeRemainingPayment(referenceText);

    const guestMatched =
      !!payment?.payerName &&
      !!reservation.guestName &&
      this.namesMatch(payment.payerName, reservation.guestName);

    // Prefer outstanding balance evidence over total-price matches.
    if (balanceDue > 0 && this.amountsMatch(amount, balanceDue)) {
      const boost = remainingPaymentHint ? 8 : 0;
      return {
        score: 35 + boost,
        reason: `Amount equals outstanding balance (${balanceDue.toFixed(2)})`,
      };
    }

    // Restzahlung / Teilzahlung + guest: prefer open-balance fits over 30% total guesses.
    if (
      guestMatched &&
      remainingPaymentHint &&
      balanceDue > 0 &&
      amount > 0 &&
      amount <= balanceDue + 1
    ) {
      const ratio = amount / balanceDue;
      if (ratio >= 0.1 && ratio <= 0.99) {
        return {
          score: 32,
          reason:
            'Guest match with Restzahlung/Teilzahlung fits the outstanding balance',
        };
      }
    }

    if (
      guestMatched &&
      balanceDue > 0 &&
      partiallyPaid &&
      this.looksLikeDepositShare(amount, balanceDue)
    ) {
      return {
        score: remainingPaymentHint ? 28 : 22,
        reason: 'Amount matches a likely deposit/installment share of the outstanding balance',
      };
    }

    // Matching the full total only makes sense when little/nothing is already paid.
    // Otherwise €852 ≈ €850 total can rank an already-paid booking above better fits.
    if (!partiallyPaid && this.amountsMatch(amount, total)) {
      return {
        score: 28,
        reason: `Amount equals reservation total (${total.toFixed(2)})`,
      };
    }

    // 30/50/70% heuristics need guest identity for hard score.
    if (
      guestMatched &&
      (this.amountsMatch(amount, total * 0.7) ||
        this.amountsMatch(amount, total * 0.5) ||
        this.amountsMatch(amount, total * 0.3))
    ) {
      return {
        score: 18,
        reason: 'Amount matches a typical deposit/installment share of the total',
      };
    }

    if (guestMatched && this.looksLikeDepositShare(amount, total)) {
      return {
        score: 18,
        reason: 'Amount matches a likely deposit/installment share of the total',
      };
    }

    // Soft review-only signals: keep ~30%/deposit alternatives visible in Needs review
    // without letting them outrank guest-name + balance matches (~25–40+).
    if (
      this.amountsMatch(amount, total * 0.7) ||
      this.amountsMatch(amount, total * 0.5) ||
      this.amountsMatch(amount, total * 0.3)
    ) {
      return {
        score: 8,
        reason: 'Soft amount guess: ~30/50/70% of booking total',
      };
    }
    if (this.looksLikeDepositShare(amount, total)) {
      return {
        score: 6,
        reason: 'Soft amount guess: within deposit/installment range of total',
      };
    }
    if (partiallyPaid && this.amountsMatch(amount, total)) {
      return {
        score: 7,
        reason: `Soft amount guess: close to reservation total (${total.toFixed(2)})`,
      };
    }
    if (balanceDue > 0 && amount > 0 && amount <= balanceDue + 1) {
      const ratio = amount / balanceDue;
      if (ratio >= 0.1 && ratio <= 0.95) {
        return {
          score: 5,
          reason: 'Soft amount guess: fits within outstanding balance',
        };
      }
    }
    return { score: 0, reason: '' };
  }

  /** Payment texts like "Restzahlung …" / "Teil …" imply settling an open balance. */
  private referenceLooksLikeRemainingPayment(referenceText: string): boolean {
    if (!referenceText) return false;
    return /restzahlung|restbetrag|rest\s*zahlung|teilzahlung|teil\s*\d|anzahlung|balance\s*due|remaining\s*(balance|payment)|final\s*payment|outstanding|installment|rate\s*\d/i.test(
      referenceText,
    );
  }

  /** True when amount is roughly 20–80% of a total (typical Anzahlung range). */
  private looksLikeDepositShare(amount: number, total: number): boolean {
    if (total <= 0 || amount <= 0) return false;
    const ratio = amount / total;
    return ratio >= 0.2 && ratio <= 0.8;
  }

  /**
   * Score against Hostaway host/guest notes (Gastgebernotiz). Notes often
   * document deposit amounts like "70% (960,05 €) Restbetrag …".
   */
  private scoreReservationNotes(
    amount: number,
    reservation: {
      hostNote: string | null;
      guestNote: string | null;
      comment: string | null;
    },
  ): { score: number; reason: string } {
    const notes = [reservation.hostNote, reservation.guestNote, reservation.comment]
      .filter(Boolean)
      .join('\n');
    if (!notes.trim()) return { score: 0, reason: '' };

    const notesNorm = notes
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '');

    let score = 0;
    const parts: string[] = [];

    const amountInNotes = this.amountAppearsInText(amount, notesNorm);
    if (amountInNotes) {
      score += 35;
      parts.push('Payment amount appears in reservation notes');
    }

    // Keywords alone (without the amount) inflated unrelated bookings in Needs review.
    if (
      amountInNotes &&
      /anzahlung|restbetrag|restzahlung|teilzahlung|deposit|vor anreise|anzuzahlen|\d+\s*%/.test(
        notesNorm,
      )
    ) {
      score += 10;
      parts.push('Reservation notes mention a deposit or remaining balance');
    }

    if (score === 0) return { score: 0, reason: '' };
    return {
      score: Math.min(score, 45),
      reason: parts.join('; '),
    };
  }

  private amountAppearsInText(amount: number, text: string): boolean {
    const fixed = amount.toFixed(2);
    const compact = fixed.replace(/\.00$/, '');
    const comma = fixed.replace('.', ',');
    const compactComma = compact.replace('.', ',');
    return (
      text.includes(fixed) ||
      text.includes(compact) ||
      text.includes(comma) ||
      text.includes(compactComma)
    );
  }

  private amountsMatch(a: number, b: number): boolean {
    // At least €1 so tiny FX/rounding noise still matches; cap relative noise at 0.5%.
    const tolerance = Math.max(1, b * 0.005);
    return Math.abs(a - b) <= tolerance;
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
      /\bres(?:ervierung|ervation)?\s*[#.:]?\s*(\d{6,9})\b/gi,
      /\b(?:buchung|booking|buchungsnr|buchungsnummer)\s*[#.:]?\s*(\d{6,9})\b/gi,
      /\b(?:buchungs-?\s*nr\.?)\s*[#.:]?\s*(\d{6,9})\b/gi,
      /\bhostaway\s*[#.:]?\s*(\d{6,9})\b/gi,
      /\bnr\.?\s*[#.:]?\s*(\d{7,8})\b/gi,
      /\b#\s*(\d{7,8})\b/g,
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

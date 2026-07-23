import {
  ExternalPaymentSource,
  PaymentMatchDecision,
} from '@prisma/client';

export interface NormalizedExternalPayment {
  source: ExternalPaymentSource;
  externalId: string;
  amount: number;
  currency: string;
  occurredAt: Date;
  payerName?: string;
  payerEmail?: string;
  reference?: string;
  rawPayload: Record<string, unknown>;
}

export interface PaymentMatchCandidate {
  reservationId: string;
  hostawayId: number;
  guestName: string | null;
  listingName: string;
  arrivalDate: string;
  departureDate: string;
  /** Booking source / channel (Airbnb, Booking.com, direct, …), if known */
  channelName: string | null;
  /** Host notes (Gastgebernotiz), truncated for UI */
  hostNote: string | null;
  /** Reservation total (booking amount), if known */
  totalPrice: number | null;
  /** Outstanding balance after notified charges, if known */
  balanceDue: number | null;
  score: number;
  reasons: string[];
}

export interface PaymentMatchResult {
  decision: PaymentMatchDecision;
  candidates: PaymentMatchCandidate[];
  best?: PaymentMatchCandidate;
  reason: string;
}

export const PAYMENT_AUTO_MATCH_MIN_SCORE = 85;
export const PAYMENT_AMBIGUITY_SCORE_GAP = 10;

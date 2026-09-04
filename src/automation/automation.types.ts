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
  /** Listing room / unit type when available */
  listingRoomType?: string | null;
  /** Cover / thumbnail URL for suggested-booking UI */
  listingCoverUrl?: string | null;
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

/** Hostaway inquiry statuses are quotes, not real bookings — exclude from payment matching. */
export const INQUIRY_RESERVATION_STATUSES = [
  'inquiry',
  'inquiryPreapproved',
  'inquiryDenied',
  'inquiryTimedout',
  'inquiryNotPossible',
] as const;

/** Statuses excluded from payment match candidates and unpaid reminders. */
export const PAYMENT_EXCLUDED_RESERVATION_STATUSES = [
  'cancelled',
  'declined',
  'expired',
  ...INQUIRY_RESERVATION_STATUSES,
] as const;

export function isInquiryReservationStatus(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return (
    normalized === 'inquiry' ||
    normalized.startsWith('inquiry')
  );
}

/**
 * Channels where the base stay is collected by the portal (not via our
 * Qonto/PayPal guest payments). Excluded from payment match candidates.
 * Direct / bookingengine / CHECK24-style imports are kept.
 */
export function isOtaPaymentChannel(
  channelName: string | null | undefined,
): boolean {
  const c = String(channelName || '').toLowerCase();
  if (!c) return false;
  if (c.includes('bookingengine')) return false;
  return (
    c.includes('airbnb') ||
    c.includes('bookingcom') ||
    c.includes('booking.com') ||
    c.includes('vrbo') ||
    c.includes('homeaway') ||
    c.includes('expedia') ||
    c.includes('agoda')
  );
}

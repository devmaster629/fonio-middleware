import type { HostawayReservation } from '../hostaway/hostaway.types';

const EXTERNAL_BOOKING_FIELD_NAMES = [
  'externe buchungsnummer',
  'externe_buchungsnummer',
  'reservation_externe_buchungsnummer',
  'external booking number',
  'external_booking_number',
  'external reservation id',
  'channel reservation id',
  'confirmation code',
  'buchungsnummer',
  'booking number',
  'booking code',
  'buchungscode',
];

function normalizeRef(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === '-' || text === 'null' || text === 'undefined') {
    return null;
  }
  return text.slice(0, 120);
}

/** Hostaway-internal ids like 64885-172749-2000-1914738831 — weak for bank matching. */
export function isHostawayInternalChannelId(ref: string): boolean {
  return /^[0-9]+(-[0-9]+){2,}$/.test(ref.trim()) && ref.trim().length >= 15;
}

/** Portal booking codes (HomeToGo 18LLT0FVVF, etc.): letters + digits, not Hostaway internals. */
export function isPortalStyleBookingCode(ref: string): boolean {
  const s = ref.trim();
  if (s.length < 6 || s.length > 40) return false;
  if (isHostawayInternalChannelId(s)) return false;
  return /[a-z]/i.test(s) && /\d/.test(s);
}

/**
 * Extract portal-style booking codes from free text (bank reference, notes, …).
 */
export function extractPortalBookingCodes(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(/\b[A-Z0-9][A-Z0-9_-]{5,39}\b/gi) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const value = normalizeRef(raw);
    if (!value || !isPortalStyleBookingCode(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function customFieldExternalRefs(remote: HostawayReservation): string[] {
  const fields = remote.customFieldValues;
  if (!Array.isArray(fields)) return [];
  const out: string[] = [];
  for (const field of fields) {
    const label = `${field?.name ?? ''} ${field?.varName ?? ''}`.toLowerCase();
    if (!EXTERNAL_BOOKING_FIELD_NAMES.some((n) => label.includes(n))) continue;
    const value = normalizeRef(field?.value);
    if (value) out.push(value);
  }
  return out;
}

/**
 * Prefer portal booking codes (custom field / confirmation / notes) over Hostaway
 * internal channelReservationId strings. Portal-agnostic.
 */
export function extractExternalBookingRef(
  remote: HostawayReservation,
): string | null {
  const noteText = [remote.guestNote, remote.hostNote, remote.comment]
    .filter(Boolean)
    .join(' ');
  const candidates = [
    ...customFieldExternalRefs(remote),
    normalizeRef(remote.confirmationCode),
    ...extractPortalBookingCodes(noteText),
    normalizeRef(remote.channelReservationId),
  ].filter((v): v is string => !!v);

  const portalLike = candidates.find((c) => isPortalStyleBookingCode(c));
  if (portalLike) return portalLike;

  const nonInternal = candidates.find((c) => !isHostawayInternalChannelId(c));
  return nonInternal || candidates[0] || null;
}

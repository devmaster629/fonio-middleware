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
];

function normalizeRef(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === '-' || text === 'null' || text === 'undefined') {
    return null;
  }
  return text.slice(0, 120);
}

function customFieldExternalRef(
  remote: HostawayReservation,
): string | null {
  const fields = remote.customFieldValues;
  if (!Array.isArray(fields)) return null;
  for (const field of fields) {
    const label = `${field?.name ?? ''} ${field?.varName ?? ''}`.toLowerCase();
    if (!EXTERNAL_BOOKING_FIELD_NAMES.some((n) => label.includes(n))) continue;
    const value = normalizeRef(field?.value);
    if (value) return value;
  }
  return null;
}

/**
 * Prefer Hostaway native channel ids, then confirmation codes, then custom fields.
 * Portal-agnostic: HomeToGo, CHECK24, Airbnb, etc.
 */
export function extractExternalBookingRef(
  remote: HostawayReservation,
): string | null {
  return (
    normalizeRef(remote.channelReservationId) ||
    normalizeRef(remote.confirmationCode) ||
    customFieldExternalRef(remote) ||
    null
  );
}

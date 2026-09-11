import { ListingStatus } from '@prisma/client';

/** Listing fields needed to decide offline / archived handling. */
export type ListingOfflineFields = {
  status: ListingStatus | string;
  isBookable: boolean;
};

/**
 * Hostaway units that are archived, draft, or otherwise not bookable.
 * Clients keep these archived on purpose (licence cost) — middleware must
 * treat them as offline and never surface Hostaway/CHECK24 API errors.
 */
export function isListingOffline(listing: ListingOfflineFields | null | undefined): boolean {
  if (!listing) return false;
  if (!listing.isBookable) return true;
  const status = String(listing.status || '').toUpperCase();
  return (
    status === ListingStatus.HIDDEN ||
    status === ListingStatus.DRAFT ||
    status === 'HIDDEN' ||
    status === 'DRAFT'
  );
}

/** True when a Hostaway/CHECK24 API error looks like an archived-unit rejection. */
export function looksLikeArchivedListingApiError(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('archiv') ||
    m.includes('not bookable') ||
    m.includes('listing is hidden') ||
    m.includes('listing is inactive') ||
    m.includes('disabled listing') ||
    m.includes('inactive listing') ||
    m.includes('deaktiviert') ||
    m.includes('ausgeblendet') ||
    // CHECK24 licence / paywall noise for units that should stay offline
    (m.includes('licen') && (m.includes('fee') || m.includes('month') || m.includes('€') || m.includes('eur'))) ||
    m.includes('lizenz')
  );
}

import {
  isListingOffline,
  looksLikeArchivedListingApiError,
} from './listing-offline.util';

describe('listing-offline.util', () => {
  it('treats non-bookable listings as offline', () => {
    expect(
      isListingOffline({ status: 'LIVE', isBookable: false }),
    ).toBe(true);
  });

  it('treats HIDDEN and DRAFT as offline even if bookable flag is wrong', () => {
    expect(isListingOffline({ status: 'HIDDEN', isBookable: true })).toBe(true);
    expect(isListingOffline({ status: 'DRAFT', isBookable: true })).toBe(true);
  });

  it('treats LIVE bookable listings as online', () => {
    expect(isListingOffline({ status: 'LIVE', isBookable: true })).toBe(false);
  });

  it('detects archived / licence-style API errors', () => {
    expect(looksLikeArchivedListingApiError('Listing is archived')).toBe(true);
    expect(looksLikeArchivedListingApiError('not bookable')).toBe(true);
    expect(
      looksLikeArchivedListingApiError('Monthly licence fee required'),
    ).toBe(true);
    expect(looksLikeArchivedListingApiError('Network timeout')).toBe(false);
  });
});

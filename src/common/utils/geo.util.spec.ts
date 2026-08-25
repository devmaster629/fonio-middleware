import { centroid, groupNearbyRegions, haversineKm, parseCoord } from './geo.util';

describe('geo.util', () => {
  it('parses Hostaway lat/lng strings', () => {
    expect(parseCoord('48.7758')).toBeCloseTo(48.7758);
    expect(parseCoord('')).toBeNull();
    expect(parseCoord(null)).toBeNull();
  });

  it('computes Stuttgart–Friedrichshafen as hundreds of km, not metres', () => {
    const km = haversineKm(
      { lat: 48.7758, lng: 9.1829 },
      { lat: 47.6567, lng: 9.465 },
    );
    expect(km).toBeGreaterThan(100);
    expect(km).toBeLessThan(200);
  });

  it('groups available listings by city and sorts by distance from origin', () => {
    const origin = centroid([
      { lat: 48.7758, lng: 9.1829 },
      { lat: 48.78, lng: 9.18 },
    ]);
    const regions = groupNearbyRegions({
      origin,
      excludeCity: 'Stuttgart',
      listings: [
        {
          listingId: 1,
          city: 'Stuttgart',
          available: true,
          lat: 48.7758,
          lng: 9.1829,
        },
        {
          listingId: 2,
          city: 'Buchenberg',
          available: true,
          lat: 47.695,
          lng: 10.242,
        },
        {
          listingId: 3,
          city: 'Friedrichshafen',
          available: true,
          lat: 47.6567,
          lng: 9.465,
        },
        {
          listingId: 4,
          city: 'Friedrichshafen',
          available: false,
          lat: 47.6567,
          lng: 9.465,
        },
      ],
    });

    expect(regions.map((r) => r.city)).toEqual(['Friedrichshafen', 'Buchenberg']);
    expect(regions[0].listingIds).toEqual([3]);
    expect(regions[0].distanceKm).not.toBeNull();
    expect(regions[0].distanceKm!).toBeLessThan(regions[1].distanceKm!);
  });
});

export function parseCoord(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function centroid(
  points: Array<{ lat: number; lng: number }>,
): { lat: number; lng: number } | null {
  if (points.length === 0) return null;
  const sum = points.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
    { lat: 0, lng: 0 },
  );
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

export function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = (a ?? '').trim().toLowerCase();
  const nb = (b ?? '').trim().toLowerCase();
  if (!na || !nb) return false;
  return na === nb;
}

export type NearbyRegion = {
  city: string;
  availableCount: number;
  distanceKm: number | null;
  listingIds: number[];
};

export function groupNearbyRegions(params: {
  listings: Array<{
    listingId: number;
    city: string | null;
    available: boolean;
    lat: number | null;
    lng: number | null;
  }>;
  origin: { lat: number; lng: number } | null;
  excludeCity?: string | null;
}): NearbyRegion[] {
  const groups = new Map<
    string,
    { listingIds: number[]; points: Array<{ lat: number; lng: number }> }
  >();

  for (const listing of params.listings) {
    if (!listing.available) continue;
    if (params.excludeCity && sameCity(listing.city, params.excludeCity)) continue;
    const city = listing.city?.trim() || 'andere Orte';
    const group = groups.get(city) ?? { listingIds: [], points: [] };
    group.listingIds.push(listing.listingId);
    if (listing.lat != null && listing.lng != null) {
      group.points.push({ lat: listing.lat, lng: listing.lng });
    }
    groups.set(city, group);
  }

  const regions: NearbyRegion[] = [...groups.entries()].map(([city, group]) => {
    const groupCenter = centroid(group.points);
    const distanceKm =
      params.origin && groupCenter
        ? Math.round(haversineKm(params.origin, groupCenter))
        : null;
    return {
      city,
      availableCount: group.listingIds.length,
      distanceKm,
      listingIds: group.listingIds,
    };
  });

  regions.sort((a, b) => {
    if (a.distanceKm != null && b.distanceKm != null && a.distanceKm !== b.distanceKm) {
      return a.distanceKm - b.distanceKm;
    }
    if (a.distanceKm != null && b.distanceKm == null) return -1;
    if (a.distanceKm == null && b.distanceKm != null) return 1;
    return a.city.localeCompare(b.city, 'de');
  });

  return regions;
}

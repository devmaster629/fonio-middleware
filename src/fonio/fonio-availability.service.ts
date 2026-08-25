import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AvailabilityMode, Listing, ListingGroup, Prisma } from '@prisma/client';
import { mapWithConcurrency } from '../common/utils/concurrency.util';
import {
  centroid,
  groupNearbyRegions,
  NearbyRegion,
  sameCity,
} from '../common/utils/geo.util';
import { PrismaService } from '../prisma/prisma.service';
import { HostawaySyncService } from '../hostaway/hostaway-sync.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { WeekendAvailabilityQueryDto } from './dto/weekend-availability-query.dto';

export interface AvailabilityResultItem {
  listingId: number;
  name: string;
  city: string | null;
  maxGuests: number;
  bedrooms: number | null;
  roomType: string | null;
  petsAllowed: boolean;
  available: boolean;
  /** True when calendar cache is incomplete and live refresh was not requested. */
  availabilityUnknown?: boolean;
  groupName: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface AvailabilitySearchResult {
  checkIn: string;
  checkOut: string;
  guests: number;
  results: AvailabilityResultItem[];
  availableCount: number;
  /** German hint for the phone assistant. Prefer this over inventing copy. */
  summaryDe: string;
  /** Other cities with availability, nearest first (only filled for nearby search or as a miss hint). */
  nearbyRegions: NearbyRegion[];
  meta: {
    dataSource: 'cache' | 'live';
    responseMs: number;
    listingsChecked: number;
    cacheIncomplete: number;
    hint?: string;
  };
}

export interface WeekendAvailabilitySlot {
  checkIn: string;
  checkOut: string;
  /** German date range for voice, e.g. "9.–11. Oktober 2026" */
  labelDe: string;
  availableCount: number;
  listingNames: string[];
  listings: AvailabilityResultItem[];
}

export interface WeekendAvailabilitySearchResult {
  year: number;
  month: number | null;
  guests: number;
  nights: number;
  weekendsChecked: number;
  weekendsWithAvailability: number;
  /** Weekends to read aloud (filtered/limited). Prefer this over inventing dates. */
  weekends: WeekendAvailabilitySlot[];
  nearbyRegions: NearbyRegion[];
  /** One-line German hint for the assistant. */
  summaryDe: string;
  meta: {
    dataSource: 'cache' | 'live';
    responseMs: number;
    listingsChecked: number;
    cacheIncomplete: number;
    truncated: boolean;
    hint?: string;
  };
}

type ListingWithGroup = Listing & { listingGroup: ListingGroup | null };

type ListingFilterQuery = {
  city?: string;
  region?: string;
  guests: number;
  pets?: boolean;
  bedrooms?: number;
  roomType?: string;
  nearby?: boolean;
};

@Injectable()
export class FonioAvailabilityService {
  private readonly cacheMaxAgeMs = 6 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: HostawaySyncService,
    private readonly config: ConfigService,
  ) {}

  async search(query: AvailabilityQueryDto): Promise<AvailabilitySearchResult> {
    const started = Date.now();
    const nights = this.enumerateDates(query.checkIn, query.checkOut);
    if (nights.length === 0) {
      throw new BadRequestException('checkOut must be after checkIn');
    }

    const nearby = query.nearby === true;
    const originCity = query.city?.trim() || undefined;
    const liveRefresh = this.resolveLiveRefresh(query.liveRefresh);
    const candidateQuery = nearby
      ? { ...query, city: undefined, region: undefined }
      : query;
    const candidates = await this.loadCandidates(candidateQuery);
    if (candidates.length === 0) {
      return this.wrapResponse(query, [], [], started, 'cache', 0);
    }

    const { daysByListing } = await this.loadCalendarForRange(
      candidates,
      nights,
      query.checkIn,
      query.checkOut,
      liveRefresh,
    );

    const results = this.evaluateListings(
      candidates,
      daysByListing,
      nights,
      liveRefresh,
    );
    const cacheIncomplete = results.filter((r) => r.availabilityUnknown).length;
    const origin = this.originFromCandidates(candidates, originCity);

    let working = nearby
      ? results.filter((r) => r.available && !sameCity(r.city, originCity))
      : [...results].sort((a, b) => Number(b.available) - Number(a.available));

    if (query.availableOnly) {
      working = working.filter((r) => r.available);
    }

    const nearbyRegions = nearby
      ? groupNearbyRegions({
          listings: results.map((r) => ({
            listingId: r.listingId,
            city: r.city,
            available: r.available,
            lat: r.lat ?? null,
            lng: r.lng ?? null,
          })),
          origin,
          excludeCity: originCity,
        })
      : [];

    working = this.sortByNearbyRegions(working, nearbyRegions);

    return this.wrapResponse(
      query,
      working,
      nearbyRegions,
      started,
      liveRefresh ? 'live' : 'cache',
      cacheIncomplete,
    );
  }

  /**
   * Check every Fri→Sun (or Fri+nights) weekend in a month/year in one call.
   * Solves "weekend in October" where inventing a single weekend misses open dates.
   */
  async searchWeekends(
    query: WeekendAvailabilityQueryDto,
  ): Promise<WeekendAvailabilitySearchResult> {
    const started = Date.now();
    const nights = query.nights ?? 2;
    const availableOnly = query.availableOnly !== false;
    const limit = query.limit ?? 8;
    const nearby = query.nearby === true;
    const originCity = query.city?.trim() || undefined;
    const liveRefresh = this.resolveLiveRefresh(query.liveRefresh);

    const weekendRanges = this.enumerateWeekends(query.year, query.month, nights);
    if (weekendRanges.length === 0) {
      throw new BadRequestException('No weekends found for the given year/month');
    }

    const candidateQuery = nearby
      ? { ...query, city: undefined, region: undefined }
      : query;
    const candidates = await this.loadCandidates(candidateQuery);
    if (candidates.length === 0) {
      return this.wrapWeekendResponse({
        query,
        nights,
        weekendRanges,
        slots: [],
        nearbyRegions: [],
        started,
        dataSource: 'cache',
        listingsChecked: 0,
        cacheIncomplete: 0,
        limit,
      });
    }

    const spanStart = weekendRanges[0].checkIn;
    const spanEnd = weekendRanges[weekendRanges.length - 1].checkOut;
    const allNights = this.uniqueDates(
      weekendRanges.flatMap((w) => this.enumerateDates(w.checkIn, w.checkOut)),
    );

    const { daysByListing } = await this.loadCalendarForRange(
      candidates,
      allNights,
      spanStart,
      spanEnd,
      liveRefresh,
    );

    const origin = this.originFromCandidates(candidates, originCity);
    const unknownListingIds = new Set<number>();
    const availableAnywhere: AvailabilityResultItem[] = [];
    const slots: WeekendAvailabilitySlot[] = [];
    for (const weekend of weekendRanges) {
      const stayNights = this.enumerateDates(weekend.checkIn, weekend.checkOut);
      const results = this.evaluateListings(
        candidates,
        daysByListing,
        stayNights,
        liveRefresh,
      );
      for (const r of results) {
        if (r.availabilityUnknown) unknownListingIds.add(r.listingId);
      }
      const available = results
        .filter((r) => r.available)
        .filter((r) => !nearby || !sameCity(r.city, originCity))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (availableOnly && available.length === 0) continue;

      for (const listing of available) {
        if (!availableAnywhere.some((x) => x.listingId === listing.listingId)) {
          availableAnywhere.push(listing);
        }
      }

      const listingNames = nearby
        ? [...new Set(available.map((r) => r.city?.trim()).filter(Boolean) as string[])]
        : available.map((r) => r.name);

      slots.push({
        checkIn: weekend.checkIn,
        checkOut: weekend.checkOut,
        labelDe: this.formatWeekendLabelDe(weekend.checkIn, weekend.checkOut),
        availableCount: available.length,
        listingNames,
        listings: availableOnly ? available : results,
      });
    }

    const nearbyRegions = nearby
      ? groupNearbyRegions({
          listings: availableAnywhere.map((r) => ({
            listingId: r.listingId,
            city: r.city,
            available: true,
            lat: r.lat ?? null,
            lng: r.lng ?? null,
          })),
          origin,
          excludeCity: originCity,
        })
      : [];

    const weekendsWithAvailability = slots.filter((s) => s.availableCount > 0).length;

    return this.wrapWeekendResponse({
      query,
      nights,
      weekendRanges,
      slots,
      nearbyRegions,
      started,
      dataSource: liveRefresh ? 'live' : 'cache',
      listingsChecked: candidates.length,
      cacheIncomplete: unknownListingIds.size,
      limit,
      weekendsWithAvailability,
    });
  }

  private wrapResponse(
    query: AvailabilityQueryDto,
    results: AvailabilityResultItem[],
    nearbyRegions: NearbyRegion[],
    started: number,
    dataSource: 'cache' | 'live',
    cacheIncomplete: number,
  ): AvailabilitySearchResult {
    const hint =
      dataSource === 'cache' && cacheIncomplete > 0
        ? 'Some listings have incomplete calendar cache. Run Hostaway sync or use liveRefresh=true for live Hostaway lookup (slower).'
        : undefined;
    const availableCount = results.filter((r) => r.available).length;

    return {
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      guests: query.guests,
      results,
      availableCount,
      summaryDe: this.buildExactDateSummaryDe(query, availableCount, nearbyRegions),
      nearbyRegions,
      meta: {
        dataSource,
        responseMs: Date.now() - started,
        listingsChecked: results.length,
        cacheIncomplete,
        hint,
      },
    };
  }

  private wrapWeekendResponse(params: {
    query: WeekendAvailabilityQueryDto;
    nights: number;
    weekendRanges: { checkIn: string; checkOut: string }[];
    slots: WeekendAvailabilitySlot[];
    nearbyRegions: NearbyRegion[];
    started: number;
    dataSource: 'cache' | 'live';
    listingsChecked: number;
    cacheIncomplete: number;
    limit: number;
    weekendsWithAvailability?: number;
  }): WeekendAvailabilitySearchResult {
    const {
      query,
      nights,
      weekendRanges,
      slots,
      nearbyRegions,
      started,
      dataSource,
      listingsChecked,
      cacheIncomplete,
      limit,
    } = params;
    const weekendsWithAvailability =
      params.weekendsWithAvailability ??
      slots.filter((s) => s.availableCount > 0).length;
    const truncated = slots.length > limit;
    const weekends = slots.slice(0, limit);

    const hint =
      dataSource === 'cache' && cacheIncomplete > 0
        ? 'Some listings have incomplete calendar cache. Run Hostaway sync or use liveRefresh=true for live Hostaway lookup (slower).'
        : undefined;

    return {
      year: query.year,
      month: query.month ?? null,
      guests: query.guests,
      nights,
      weekendsChecked: weekendRanges.length,
      weekendsWithAvailability,
      weekends,
      nearbyRegions,
      summaryDe: this.buildWeekendSummaryDe(
        query,
        weekendsWithAvailability,
        weekends,
        truncated,
        nearbyRegions,
      ),
      meta: {
        dataSource,
        responseMs: Date.now() - started,
        listingsChecked,
        cacheIncomplete,
        truncated,
        hint,
      },
    };
  }

  private resolveLiveRefresh(liveRefresh?: boolean): boolean {
    return (
      liveRefresh === true ||
      this.config.get('AVAILABILITY_LIVE_REFRESH_DEFAULT') === 'true'
    );
  }

  private async loadCandidates(
    query: ListingFilterQuery,
  ): Promise<ListingWithGroup[]> {
    const where: Prisma.ListingWhereInput = {
      isBookable: true,
      personCapacity: { gte: query.guests },
    };

    if (query.city) {
      where.city = { contains: query.city, mode: 'insensitive' };
    }
    if (query.region) {
      where.region = { contains: query.region, mode: 'insensitive' };
    }
    if (query.pets) {
      where.petsAllowed = true;
    }
    if (query.bedrooms) {
      where.bedroomsNumber = { gte: query.bedrooms };
    }
    if (query.roomType) {
      where.roomType = query.roomType;
    }

    const listings = await this.prisma.listing.findMany({
      where,
      include: { listingGroup: true },
      take: 100,
    });

    return listings.filter((l) => this.isVisibleForGroupMode(l));
  }

  private async loadCalendarForRange(
    candidates: ListingWithGroup[],
    nights: Date[],
    rangeStart: string,
    rangeEnd: string,
    liveRefresh: boolean,
  ) {
    const listingIds = candidates.map((l) => l.id);
    let cachedDays = await this.prisma.calendarDay.findMany({
      where: {
        listingId: { in: listingIds },
        date: { in: nights },
      },
    });

    const { daysByListing, staleListings } = this.indexCalendarDays(
      cachedDays,
      candidates,
      nights,
    );

    if (liveRefresh && staleListings.length > 0) {
      const syncConcurrency = Number(
        this.config.get('AVAILABILITY_SYNC_CONCURRENCY') ?? 3,
      );
      await mapWithConcurrency(staleListings, syncConcurrency, async (listing) => {
        await this.sync.syncListingCalendar(
          listing.hostawayId,
          rangeStart,
          rangeEnd,
        );
      });
      cachedDays = await this.prisma.calendarDay.findMany({
        where: {
          listingId: { in: listingIds },
          date: { in: nights },
        },
      });
    }

    const { daysByListing: finalDays } = this.indexCalendarDays(
      cachedDays,
      candidates,
      nights,
    );

    return { daysByListing: finalDays };
  }

  private evaluateListings(
    candidates: ListingWithGroup[],
    daysByListing: Map<
      string,
      {
        listingId: string;
        date: Date;
        isAvailable: boolean;
        minNights: number | null;
        syncedAt: Date;
      }[]
    >,
    nights: Date[],
    liveRefresh: boolean,
  ): AvailabilityResultItem[] {
    const nightKeys = new Set(nights.map((d) => d.toISOString().slice(0, 10)));

    return candidates.map((listing) => {
      const allDays = daysByListing.get(listing.id) ?? [];
      const days = allDays.filter((d) =>
        nightKeys.has(d.date.toISOString().slice(0, 10)),
      );
      const cacheComplete = days.length >= nights.length;
      const available =
        cacheComplete && this.isStayAvailable(days, nights.length);
      return {
        listingId: listing.hostawayId,
        name: listing.name,
        city: listing.city,
        maxGuests: listing.personCapacity,
        bedrooms: listing.bedroomsNumber,
        roomType: listing.roomType,
        petsAllowed: listing.petsAllowed,
        available,
        availabilityUnknown: !liveRefresh && !cacheComplete,
        groupName: listing.listingGroup?.name ?? null,
        lat: listing.lat,
        lng: listing.lng,
      };
    });
  }

  private indexCalendarDays(
    cachedDays: {
      listingId: string;
      date: Date;
      isAvailable: boolean;
      minNights: number | null;
      syncedAt: Date;
    }[],
    candidates: ListingWithGroup[],
    nights: Date[],
  ) {
    const daysByListing = new Map<string, typeof cachedDays>();
    const latestSyncByListing = new Map<string, Date>();

    for (const day of cachedDays) {
      const bucket = daysByListing.get(day.listingId) ?? [];
      bucket.push(day);
      daysByListing.set(day.listingId, bucket);
      const prev = latestSyncByListing.get(day.listingId);
      if (!prev || day.syncedAt > prev) {
        latestSyncByListing.set(day.listingId, day.syncedAt);
      }
    }

    const staleListings = candidates.filter((listing) => {
      const latest = latestSyncByListing.get(listing.id);
      const hasAllNights =
        (daysByListing.get(listing.id)?.length ?? 0) >= nights.length;
      const cacheFresh =
        latest && Date.now() - latest.getTime() < this.cacheMaxAgeMs;
      return !hasAllNights || !cacheFresh;
    });

    return { daysByListing, staleListings };
  }

  /** Respect PARENT_ONLY / CHILDREN_ONLY / BOTH from listing groups. */
  private isVisibleForGroupMode(listing: ListingWithGroup): boolean {
    const group = listing.listingGroup;
    if (!group) return true;

    switch (group.availabilityMode) {
      case AvailabilityMode.PARENT_ONLY:
        return listing.hostawayId === group.hostawayParentId;
      case AvailabilityMode.CHILDREN_ONLY:
        return (
          listing.parentHostawayId !== null &&
          listing.hostawayId !== group.hostawayParentId
        );
      default:
        return true;
    }
  }

  private isStayAvailable(
    days: { isAvailable: boolean; minNights: number | null }[],
    stayNights: number,
  ): boolean {
    if (days.length !== stayNights) return false;
    if (!days.every((d) => d.isAvailable)) return false;
    const requiredMin = Math.max(...days.map((d) => d.minNights ?? 1), 1);
    return stayNights >= requiredMin;
  }

  /** Fridays in month (or year) with checkOut = Friday + nights. */
  enumerateWeekends(
    year: number,
    month: number | undefined,
    nights: number,
  ): { checkIn: string; checkOut: string }[] {
    const weekends: { checkIn: string; checkOut: string }[] = [];
    const months = month ? [month] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    for (const m of months) {
      const daysInMonth = new Date(Date.UTC(year, m, 0)).getUTCDate();
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(Date.UTC(year, m - 1, day));
        // 5 = Friday
        if (date.getUTCDay() !== 5) continue;
        const checkIn = this.formatDateOnly(date);
        const checkOutDate = new Date(date);
        checkOutDate.setUTCDate(checkOutDate.getUTCDate() + nights);
        weekends.push({
          checkIn,
          checkOut: this.formatDateOnly(checkOutDate),
        });
      }
    }

    return weekends;
  }

  private uniqueDates(dates: Date[]): Date[] {
    const seen = new Set<string>();
    const out: Date[] = [];
    for (const d of dates) {
      const key = d.toISOString().slice(0, 10);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out;
  }

  private formatDateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private formatWeekendLabelDe(checkIn: string, checkOut: string): string {
    const months = [
      'Januar',
      'Februar',
      'März',
      'April',
      'Mai',
      'Juni',
      'Juli',
      'August',
      'September',
      'Oktober',
      'November',
      'Dezember',
    ];
    const [y1, m1, d1] = checkIn.split('-').map(Number);
    const [y2, m2, d2] = checkOut.split('-').map(Number);
    if (y1 === y2 && m1 === m2) {
      return `${d1}.–${d2}. ${months[m1 - 1]} ${y1}`;
    }
    if (y1 === y2) {
      return `${d1}. ${months[m1 - 1]} – ${d2}. ${months[m2 - 1]} ${y1}`;
    }
    return `${d1}. ${months[m1 - 1]} ${y1} – ${d2}. ${months[m2 - 1]} ${y2}`;
  }

  private originFromCandidates(
    candidates: ListingWithGroup[],
    originCity?: string,
  ): { lat: number; lng: number } | null {
    const pool = originCity
      ? candidates.filter((l) => sameCity(l.city, originCity))
      : candidates;
    return centroid(
      pool
        .filter((l) => l.lat != null && l.lng != null)
        .map((l) => ({ lat: l.lat as number, lng: l.lng as number })),
    );
  }

  private sortByNearbyRegions(
    listings: AvailabilityResultItem[],
    regions: NearbyRegion[],
  ): AvailabilityResultItem[] {
    if (regions.length === 0) return listings;
    const order = new Map(regions.map((r, i) => [r.city.toLowerCase(), i]));
    return [...listings].sort((a, b) => {
      const ai = order.get((a.city ?? '').trim().toLowerCase()) ?? 999;
      const bi = order.get((b.city ?? '').trim().toLowerCase()) ?? 999;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name, 'de');
    });
  }

  private formatRegionsDe(regions: NearbyRegion[]): string {
    return regions
      .map((r) =>
        r.distanceKm != null ? `${r.city} (ca. ${r.distanceKm} km)` : r.city,
      )
      .join(', ');
  }

  private buildExactDateSummaryDe(
    query: AvailabilityQueryDto,
    availableCount: number,
    nearbyRegions: NearbyRegion[],
  ): string {
    const place =
      query.city?.trim() || query.region?.trim() || 'den gesuchten Ort';

    if (query.nearby) {
      if (nearbyRegions.length === 0) {
        return `An denselben Daten in anderen Regionen ebenfalls nichts frei. Anderen Zeitraum in ${place} anbieten oder an Mitarbeiter weiterleiten. Regionen nennen, keine Wohnungsliste.`;
      }
      return `An denselben Daten nächstgelegene freie Regionen: ${this.formatRegionsDe(nearbyRegions)}. Nur Regionen nennen, keine Wohnungen vorlesen. listingId aus nearbyRegions merken, falls der Gast eine Region wählt.`;
    }

    if (availableCount > 0) {
      return `${availableCount} Unterkunft/Unterkünfte in ${place} für diese Daten frei. Kurz nennen, keine unnötige Wohnungsliste.`;
    }

    return `In ${place} für diese Daten nichts frei. Zwei Optionen anbieten: 1) andere Daten am gleichen Ort (neuen Zeitraum fragen, nearby nicht setzen) 2) andere Orte an denselben Daten. Bei 2 NICHT fragen wo genau — sofort erneut Verfuegbarkeit_pruefen mit nearby=true und gleichen city, checkIn, checkOut, guests, pets.`;
  }

  private buildWeekendSummaryDe(
    query: WeekendAvailabilityQueryDto,
    weekendsWithAvailability: number,
    weekends: WeekendAvailabilitySlot[],
    truncated: boolean,
    nearbyRegions: NearbyRegion[],
  ): string {
    const place =
      query.city?.trim() ||
      query.region?.trim() ||
      'den gesuchten Ort';
    const period =
      query.month != null
        ? this.monthNameDe(query.month) + ` ${query.year}`
        : `Jahr ${query.year}`;

    if (query.nearby) {
      if (nearbyRegions.length === 0) {
        return `Keine freien Wochenenden in anderen Regionen für ${period}. Anderen Zeitraum in ${place} anbieten.`;
      }
      return `Freie Wochenenden in anderen Regionen, nächstgelegen zuerst: ${this.formatRegionsDe(nearbyRegions)}. Nur Regionen nennen, keine Wohnungen.`;
    }

    if (weekendsWithAvailability === 0) {
      return `Keine freien Wochenenden in ${place} für ${period} (${query.guests} Person(en)). Zwei Optionen: anderer Zeitraum am gleichen Ort, oder andere Orte im selben Zeitraum (nearby=true, NICHT nach genauem Ort fragen).`;
    }

    const samples = weekends
      .filter((w) => w.availableCount > 0)
      .slice(0, 3)
      .map((w) => `${w.labelDe} (${w.listingNames.slice(0, 2).join(', ')})`)
      .join('; ');

    const more = truncated
      ? ` Weitere freie Wochenenden vorhanden (Antwort auf ${weekends.length} begrenzt).`
      : '';

    return `${weekendsWithAvailability} freie Wochenende(n) in ${place} für ${period}. Beispiele: ${samples}.${more}`;
  }

  private monthNameDe(month: number): string {
    const months = [
      'Januar',
      'Februar',
      'März',
      'April',
      'Mai',
      'Juni',
      'Juli',
      'August',
      'September',
      'Oktober',
      'November',
      'Dezember',
    ];
    return months[month - 1] ?? String(month);
  }

  private enumerateDates(checkIn: string, checkOut: string): Date[] {
    const dates: Date[] = [];
    const current = this.parseDateOnly(checkIn);
    const end = this.parseDateOnly(checkOut);
    while (current < end) {
      dates.push(new Date(current));
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
  }

  private parseDateOnly(iso: string): Date {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AvailabilityMode, Listing, ListingGroup, Prisma } from '@prisma/client';
import { mapWithConcurrency } from '../common/utils/concurrency.util';
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
}

export interface AvailabilitySearchResult {
  checkIn: string;
  checkOut: string;
  guests: number;
  results: AvailabilityResultItem[];
  availableCount: number;
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

    const liveRefresh = this.resolveLiveRefresh(query.liveRefresh);
    const candidates = await this.loadCandidates(query);
    if (candidates.length === 0) {
      return this.wrapResponse(query, [], started, 'cache', 0);
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

    const sorted = results.sort((a, b) => Number(b.available) - Number(a.available));
    const filtered = query.availableOnly
      ? sorted.filter((r) => r.available)
      : sorted;

    return this.wrapResponse(
      query,
      filtered,
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
    const liveRefresh = this.resolveLiveRefresh(query.liveRefresh);

    const weekendRanges = this.enumerateWeekends(query.year, query.month, nights);
    if (weekendRanges.length === 0) {
      throw new BadRequestException('No weekends found for the given year/month');
    }

    const candidates = await this.loadCandidates(query);
    if (candidates.length === 0) {
      return this.wrapWeekendResponse({
        query,
        nights,
        weekendRanges,
        slots: [],
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

    const unknownListingIds = new Set<number>();
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
        .sort((a, b) => a.name.localeCompare(b.name));

      if (availableOnly && available.length === 0) continue;

      slots.push({
        checkIn: weekend.checkIn,
        checkOut: weekend.checkOut,
        labelDe: this.formatWeekendLabelDe(weekend.checkIn, weekend.checkOut),
        availableCount: available.length,
        listingNames: available.map((r) => r.name),
        listings: availableOnly ? available : results,
      });
    }

    const weekendsWithAvailability = slots.filter((s) => s.availableCount > 0).length;

    return this.wrapWeekendResponse({
      query,
      nights,
      weekendRanges,
      slots,
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
    started: number,
    dataSource: 'cache' | 'live',
    cacheIncomplete: number,
  ): AvailabilitySearchResult {
    const hint =
      dataSource === 'cache' && cacheIncomplete > 0
        ? 'Some listings have incomplete calendar cache. Run Hostaway sync or use liveRefresh=true for live Hostaway lookup (slower).'
        : undefined;

    return {
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      guests: query.guests,
      results,
      availableCount: results.filter((r) => r.available).length,
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
      summaryDe: this.buildWeekendSummaryDe(
        query,
        weekendsWithAvailability,
        weekends,
        truncated,
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

  private buildWeekendSummaryDe(
    query: WeekendAvailabilityQueryDto,
    weekendsWithAvailability: number,
    weekends: WeekendAvailabilitySlot[],
    truncated: boolean,
  ): string {
    const place =
      query.city?.trim() ||
      query.region?.trim() ||
      'den gesuchten Ort';
    const period =
      query.month != null
        ? this.monthNameDe(query.month) + ` ${query.year}`
        : `Jahr ${query.year}`;

    if (weekendsWithAvailability === 0) {
      return `Keine freien Wochenenden in ${place} für ${period} (${query.guests} Person(en)).`;
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

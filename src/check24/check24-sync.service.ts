import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ListingStatus } from '@prisma/client';
import { mapWithConcurrency } from '../common/utils/concurrency.util';
import { HostawayClient } from '../hostaway/hostaway.client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildAvailabilityRanges,
  buildStandardPricingRanges,
} from './check24-calendar.util';
import { Check24Client } from './check24.client';
import { Check24PropertyMapper } from './check24-property.mapper';
import { Check24Property } from './check24.types';

@Injectable()
export class Check24SyncService {
  private readonly logger = new Logger(Check24SyncService.name);
  private syncInProgress = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly check24: Check24Client,
    private readonly hostaway: HostawayClient,
    private readonly mapper: Check24PropertyMapper,
  ) {}

  isConfigured(): boolean {
    return (
      this.isEnabled() &&
      this.check24.isConfigured()
    );
  }

  isEnabled(): boolean {
    return (this.config.get<string>('CHECK24_ENABLED') ?? 'false').toLowerCase() ===
      'true';
  }

  isSyncInProgress(): boolean {
    return this.syncInProgress;
  }

  async status() {
    const [mappings, bookings, lastJob] = await Promise.all([
      this.prisma.check24PropertyMapping.count(),
      this.prisma.check24Booking.count(),
      this.prisma.syncJob.findFirst({
        where: { jobType: { startsWith: 'check24:' } },
        orderBy: { startedAt: 'desc' },
      }),
    ]);

    let ping: { ok: boolean; message?: string; error?: string } = {
      ok: false,
    };
    if (this.check24.isConfigured()) {
      try {
        const p = await this.check24.ping();
        ping = { ok: true, message: p.message ?? 'pong' };
      } catch (err) {
        ping = { ok: false, error: this.check24.describeError(err) };
      }
    }

    return {
      enabled: this.isEnabled(),
      configured: this.check24.isConfigured(),
      syncInProgress: this.syncInProgress,
      mappings,
      bookings,
      ping,
      lastJob,
      baseUrl:
        this.config.get<string>('CHECK24_API_BASE_URL') ??
        'https://supplyapistaging.ferienwohnung.check24-test.de/api/v2',
    };
  }

  async syncAll(options?: {
    content?: boolean;
    availability?: boolean;
    rates?: boolean;
    listingIds?: number[];
  }) {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'CHECK24 is disabled or CHECK24_API_TOKEN is not set',
      );
    }
    if (this.syncInProgress) {
      throw new ConflictException('CHECK24 sync already running');
    }

    this.syncInProgress = true;
    const job = await this.prisma.syncJob.create({
      data: {
        jobType: 'check24:full',
        status: 'running',
        metadata: options ?? {},
      },
    });

    const doContent = options?.content !== false;
    const doAvailability = options?.availability !== false;
    const doRates = options?.rates !== false;

    try {
      const listings = await this.prisma.listing.findMany({
        where: {
          isBookable: true,
          status: ListingStatus.LIVE,
          ...(options?.listingIds?.length
            ? { hostawayId: { in: options.listingIds } }
            : {}),
        },
        include: { check24Mapping: true },
        orderBy: { hostawayId: 'asc' },
      });

      const concurrency = Number(this.config.get('CHECK24_SYNC_CONCURRENCY') ?? 2);
      const delayMs = Number(this.config.get('CHECK24_SYNC_DELAY_MS') ?? 200);

      const maxAttempts = Math.max(
        1,
        Number(this.config.get('CHECK24_SYNC_RETRY_ATTEMPTS') ?? 3),
      );
      const retryDelayMs = Math.max(
        0,
        Number(this.config.get('CHECK24_SYNC_RETRY_DELAY_MS') ?? 2000),
      );

      type ListingRow = (typeof listings)[number];
      let pending: ListingRow[] = [...listings];
      const errors: Array<{ hostawayId: number; error: string }> = [];

      for (let attempt = 1; attempt <= maxAttempts && pending.length; attempt++) {
        const failedThisRound: ListingRow[] = [];
        const attemptErrors = new Map<number, string>();

        await mapWithConcurrency(pending, concurrency, async (listing) => {
          try {
            if (doContent) await this.syncListingContent(listing.id);
            if (doAvailability) await this.syncListingAvailability(listing.id);
            if (doRates) await this.syncListingRates(listing.id);
          } catch (err) {
            const message = this.check24.describeError(err);
            attemptErrors.set(listing.hostawayId, message);
            failedThisRound.push(listing);
            const propertyId = this.mapper.propertyIdForHostaway(
              listing.hostawayId,
            );
            await this.upsertMapping(listing.id, propertyId, {
              lastError: message.slice(0, 1000),
            });
            this.logger.warn(
              `CHECK24 sync failed for listing ${listing.hostawayId} (attempt ${attempt}/${maxAttempts}): ${message}`,
            );
          }
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        });

        pending = failedThisRound;
        errors.length = 0;
        for (const [hostawayId, error] of attemptErrors) {
          errors.push({ hostawayId, error });
        }

        if (pending.length && attempt < maxAttempts) {
          this.logger.log(
            `CHECK24 retrying ${pending.length} failed listing(s) after ${retryDelayMs * attempt}ms…`,
          );
          if (retryDelayMs > 0) {
            await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
          }
        }
      }

      const succeeded = listings.length - pending.length;
      const metadata = {
        listings: listings.length,
        contentOk: doContent ? succeeded : 0,
        availabilityOk: doAvailability ? succeeded : 0,
        ratesOk: doRates ? succeeded : 0,
        attempts: maxAttempts,
        errors,
      };
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: errors.length ? 'completed_with_errors' : 'completed',
          finishedAt: new Date(),
          metadata,
          error: errors.length
            ? `${errors.length} listing(s) failed after ${maxAttempts} attempt(s)`
            : null,
        },
      });
      return metadata;
    } catch (err) {
      const message = this.check24.describeError(err);
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: message.slice(0, 2000),
        },
      });
      throw err;
    } finally {
      this.syncInProgress = false;
    }
  }

  /** Re-push listings that still have a lastError (used by scheduler). */
  async retryFailedListings() {
    const failed = await this.prisma.check24PropertyMapping.findMany({
      where: { lastError: { not: null } },
      include: { listing: { select: { hostawayId: true } } },
    });
    if (!failed.length) {
      return { attempted: 0, succeeded: 0, errors: [] as Array<{ hostawayId: number; error: string }> };
    }

    const listingIds = failed
      .map((m) => m.listing.hostawayId)
      .filter((id): id is number => Number.isFinite(id));

    const result = await this.syncAll({
      content: true,
      availability: true,
      rates: true,
      listingIds,
    });

    return {
      attempted: listingIds.length,
      succeeded: listingIds.length - (result.errors?.length ?? 0),
      errors: result.errors ?? [],
    };
  }

  async syncListingContent(listingId: string) {
    const listing = await this.prisma.listing.findUniqueOrThrow({
      where: { id: listingId },
    });
    const remote = await this.hostaway.getListing(listing.hostawayId);
    const property = this.mapper.mapListing(listing, remote);
    await this.check24.pushProperties([property]);
    await this.upsertMapping(listing.id, property.propertyId, {
      contentSyncedAt: new Date(),
      lastError: null,
    });
    return property.propertyId;
  }

  async syncListingAvailability(listingId: string) {
    const listing = await this.prisma.listing.findUniqueOrThrow({
      where: { id: listingId },
      include: { check24Mapping: true },
    });
    const propertyId =
      listing.check24Mapping?.check24PropertyId ??
      this.mapper.propertyIdForHostaway(listing.hostawayId);

    const days = await this.prisma.calendarDay.findMany({
      where: {
        listingId: listing.id,
        date: { gte: new Date(new Date().toISOString().slice(0, 10)) },
      },
      orderBy: { date: 'asc' },
      select: {
        date: true,
        isAvailable: true,
        minNights: true,
        price: true,
      },
    });

    const ranges = buildAvailabilityRanges(days);
    if (ranges.length === 0) {
      this.logger.warn(
        `No calendar days for listing ${listing.hostawayId}; skipping availability push`,
      );
      return;
    }

    await this.check24.pushAvailability(propertyId, ranges);
    await this.upsertMapping(listing.id, propertyId, {
      availabilitySyncedAt: new Date(),
      lastError: null,
    });
  }

  async syncListingRates(listingId: string) {
    const listing = await this.prisma.listing.findUniqueOrThrow({
      where: { id: listingId },
      include: { check24Mapping: true },
    });
    const propertyId =
      listing.check24Mapping?.check24PropertyId ??
      this.mapper.propertyIdForHostaway(listing.hostawayId);

    const days = await this.prisma.calendarDay.findMany({
      where: {
        listingId: listing.id,
        date: { gte: new Date(new Date().toISOString().slice(0, 10)) },
      },
      orderBy: { date: 'asc' },
      select: {
        date: true,
        isAvailable: true,
        minNights: true,
        price: true,
      },
    });

    const standardPricing = buildStandardPricingRanges(days);
    if (standardPricing.length === 0) {
      this.logger.warn(
        `No priced calendar days for listing ${listing.hostawayId}; skipping rates push`,
      );
      return;
    }

    await this.check24.pushRates(propertyId, [
      {
        currencyCode: 'EUR',
        vat: Number(this.config.get('CHECK24_VAT_PERCENT') ?? 0),
        standardPricing,
      },
    ]);
    await this.upsertMapping(listing.id, propertyId, {
      ratesSyncedAt: new Date(),
      lastError: null,
    });
  }

  async ensureMappingForListing(listingId: string) {
    const listing = await this.prisma.listing.findUniqueOrThrow({
      where: { id: listingId },
      include: { check24Mapping: true },
    });
    if (listing.check24Mapping) return listing.check24Mapping;
    const propertyId = this.mapper.propertyIdForHostaway(listing.hostawayId);
    return this.upsertMapping(listing.id, propertyId, {});
  }

  async listMappings() {
    return this.prisma.check24PropertyMapping.findMany({
      include: {
        listing: {
          select: {
            id: true,
            hostawayId: true,
            name: true,
            city: true,
            isBookable: true,
            status: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async setMappingEnabled(mappingId: string, enabled: boolean) {
    return this.prisma.check24PropertyMapping.update({
      where: { id: mappingId },
      data: { enabled },
    });
  }

  async previewProperty(hostawayId: number): Promise<Check24Property> {
    const listing = await this.prisma.listing.findUnique({
      where: { hostawayId },
    });
    if (!listing) {
      throw new ServiceUnavailableException(
        `Listing ${hostawayId} not found locally — run Hostaway sync first`,
      );
    }
    const remote = await this.hostaway.getListing(hostawayId);
    return this.mapper.mapListing(listing, remote);
  }

  async findListingIdByHostawayId(hostawayId: number): Promise<string | null> {
    const listing = await this.prisma.listing.findUnique({
      where: { hostawayId },
      select: { id: true },
    });
    return listing?.id ?? null;
  }

  private async upsertMapping(
    listingId: string,
    check24PropertyId: string,
    data: {
      contentSyncedAt?: Date | null;
      availabilitySyncedAt?: Date | null;
      ratesSyncedAt?: Date | null;
      lastError?: string | null;
      enabled?: boolean;
    },
  ) {
    return this.prisma.check24PropertyMapping.upsert({
      where: { listingId },
      create: {
        listingId,
        check24PropertyId,
        enabled: data.enabled ?? true,
        contentSyncedAt: data.contentSyncedAt ?? null,
        availabilitySyncedAt: data.availabilitySyncedAt ?? null,
        ratesSyncedAt: data.ratesSyncedAt ?? null,
        lastError: data.lastError ?? null,
      },
      update: {
        check24PropertyId,
        ...data,
      },
    });
  }
}

import { ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Listing, ListingStatus, Prisma } from '@prisma/client';
import { mapWithConcurrency } from '../common/utils/concurrency.util';
import { hashPhoneForStorage, hashValue, maskGuestName } from '../common/utils/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { HostawayClient } from './hostaway.client';
import { HostawayConversationService } from './hostaway-conversation.service';
import { GuestRequestInboxService } from './guest-request-inbox.service';
import { HostawayCalendarDay, HostawayReservation } from './hostaway.types';
import { EXCLUDED_LISTING_IDS } from './listing-hierarchy.config';
import { ListingHierarchyService } from './listing-hierarchy.service';
import {
  PaymentInboxService,
  ProcessPaymentUpdatesResult,
} from './payment-inbox.service';

@Injectable()
export class HostawaySyncService implements OnModuleInit {
  private readonly logger = new Logger(HostawaySyncService.name);
  private syncInProgress = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hostaway: HostawayClient,
    private readonly hierarchy: ListingHierarchyService,
    private readonly config: ConfigService,
    private readonly conversations: HostawayConversationService,
    private readonly guestInbox: GuestRequestInboxService,
    private readonly paymentInbox: PaymentInboxService,
  ) {}

  async onModuleInit() {
    const stale = await this.prisma.syncJob.updateMany({
      where: { status: 'running' },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        error: 'Interrupted — server restarted or sync did not finish',
      },
    });
    if (stale.count > 0) {
      this.logger.warn(`Marked ${stale.count} stale sync job(s) as failed`);
    }
  }

  isSyncInProgress(): boolean {
    return this.syncInProgress;
  }

  async syncAll(jobType = 'full_sync'): Promise<{
    listings: number;
    reservations: number;
    calendarDays: number;
    removedListings: number;
  }> {
    if (this.syncInProgress) {
      throw new ConflictException('Hostaway sync is already running');
    }

    this.syncInProgress = true;
    const job = await this.prisma.syncJob.create({
      data: { jobType, status: 'running', metadata: { phase: 'listings' } },
    });

    try {
      const remoteListings = await this.hostaway.getAllListings();
      await this.syncListingGroups(remoteListings);
      const listings = await this.syncListings(remoteListings);
      const removedListings = await this.removeStaleListings(remoteListings);
      await this.updateJobProgress(job.id, {
        phase: 'reservations',
        listings,
        removedListings,
      });

      const reservations = await this.syncAllReservations(job.id);
      const conversationBackfill = await this.maybeBackfillConversations();
      await this.updateJobProgress(job.id, {
        phase: 'calendars',
        listings,
        reservations,
        removedListings,
        conversationBackfill,
      });

      const calendarDays = await this.syncAllCalendars(job.id);
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          finishedAt: new Date(),
          metadata: {
            phase: 'done',
            listings,
            reservations,
            calendarDays,
            removedListings,
          },
        },
      });
      return { listings, reservations, calendarDays, removedListings };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: { status: 'failed', finishedAt: new Date(), error: message },
      });
      throw error;
    } finally {
      this.syncInProgress = false;
    }
  }

  private async updateJobProgress(
    jobId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.prisma.syncJob.update({
      where: { id: jobId },
      data: { metadata: metadata as object },
    });
  }

  private async syncListingGroups(
    remotes?: Awaited<ReturnType<HostawayClient['getAllListings']>>,
  ) {
    const remoteListings = remotes ?? (await this.hostaway.getAllListings());
    const groups = await this.hierarchy.discoverGroups(remoteListings);

    await this.prisma.$transaction(
      groups.map((group) =>
        this.prisma.listingGroup.upsert({
          where: { hostawayParentId: group.parentHostawayId },
          create: {
            hostawayParentId: group.parentHostawayId,
            name: group.name,
            city: group.city,
            availabilityMode: group.availabilityMode,
          },
          update: {
            name: group.name,
            city: group.city,
            availabilityMode: group.availabilityMode,
          },
        }),
      ),
    );
  }

  async syncListings(
    remotes?: Awaited<ReturnType<HostawayClient['getAllListings']>>,
  ): Promise<number> {
    const remoteListings = remotes ?? (await this.hostaway.getAllListings());
    const groups = await this.prisma.listingGroup.findMany();
    const groupByParentId = new Map(
      groups.map((g) => [g.hostawayParentId, g]),
    );

    await mapWithConcurrency(remoteListings, 5, async (remote) => {
      const tags = (remote.listingTags ?? []).map((t) => t.name);
      const petsAllowed = (remote.listingAmenities ?? []).some((a) =>
        a.amenityName.toLowerCase().includes('pet'),
      );
      const parentHostawayId = this.hierarchy.resolveParent(remote.id);
      const group = parentHostawayId
        ? groupByParentId.get(parentHostawayId)
        : null;

      const status = this.mapListingStatus(remote.specialStatus);
      const isBookable =
        status === ListingStatus.LIVE &&
        !EXCLUDED_LISTING_IDS.includes(remote.id);

      await this.prisma.listing.upsert({
        where: { hostawayId: remote.id },
        create: {
          hostawayId: remote.id,
          name: remote.name,
          city: remote.city,
          region: remote.state,
          personCapacity: remote.personCapacity ?? 1,
          bedroomsNumber: remote.bedroomsNumber,
          roomType: remote.roomType,
          petsAllowed,
          status,
          isBookable,
          listingGroupId: group?.id,
          parentHostawayId,
          tags,
          lastSyncedAt: new Date(),
        },
        update: {
          name: remote.name,
          city: remote.city,
          region: remote.state,
          personCapacity: remote.personCapacity ?? 1,
          bedroomsNumber: remote.bedroomsNumber,
          roomType: remote.roomType,
          petsAllowed,
          status,
          isBookable,
          listingGroupId: group?.id,
          parentHostawayId,
          tags,
          lastSyncedAt: new Date(),
        },
      });
    });

    this.logger.log(`Synced ${remoteListings.length} listings`);
    return remoteListings.length;
  }

  private async removeStaleListings(
    remotes: Awaited<ReturnType<HostawayClient['getAllListings']>>,
  ): Promise<number> {
    const remoteIds = remotes.map((l) => l.id);
    const result = await this.prisma.listing.updateMany({
      where: {
        hostawayId: { notIn: remoteIds },
        status: { not: ListingStatus.HIDDEN },
      },
      data: { status: ListingStatus.HIDDEN, isBookable: false },
    });
    if (result.count > 0) {
      this.logger.log(`Marked ${result.count} removed Hostaway listings as hidden`);
    }
    return result.count;
  }

  async syncListingCalendar(
    hostawayListingId: number,
    startDate: string,
    endDate: string,
  ): Promise<number> {
    const listing = await this.prisma.listing.findUnique({
      where: { hostawayId: hostawayListingId },
    });
    if (!listing) return 0;

    const days = await this.hostaway.getCalendar(
      hostawayListingId,
      startDate,
      endDate,
    );

    await this.upsertCalendarDays(listing.id, days);
    return days.length;
  }

  private async upsertCalendarDays(
    listingId: string,
    days: HostawayCalendarDay[],
  ) {
    const chunkSize = 50;
    const syncedAt = new Date();

    for (let i = 0; i < days.length; i += chunkSize) {
      const chunk = days.slice(i, i + chunkSize);
      await this.prisma.$transaction(
        chunk.map((day) => {
          const date = new Date(day.date);
          return this.prisma.calendarDay.upsert({
            where: {
              listingId_date: { listingId, date },
            },
            create: {
              listingId,
              date,
              isAvailable: day.isAvailable === 1,
              minNights: day.minimumStay,
              price: day.price,
              syncedAt,
            },
            update: {
              isAvailable: day.isAvailable === 1,
              minNights: day.minimumStay,
              price: day.price,
              syncedAt,
            },
          });
        }),
      );
    }
  }

  private async syncAllCalendars(jobId?: string): Promise<number> {
    const daysAhead = Number(this.config.get('CALENDAR_SYNC_DAYS') ?? 365);
    const concurrency = Number(this.config.get('CALENDAR_SYNC_CONCURRENCY') ?? 3);
    const delayMs = Number(this.config.get('CALENDAR_SYNC_DELAY_MS') ?? 100);
    const listings = await this.prisma.listing.findMany({
      where: { isBookable: true },
      select: { id: true, hostawayId: true },
    });
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + daysAhead);
    const format = (d: Date) => d.toISOString().slice(0, 10);
    const startStr = format(today);
    const endStr = format(end);

    let total = 0;
    let completed = 0;

    await mapWithConcurrency(listings, concurrency, async (listing, index) => {
      try {
        const count = await this.syncListingCalendar(
          listing.hostawayId,
          startStr,
          endStr,
        );
        total += count;
        completed += 1;

        if (
          jobId &&
          (completed === 1 ||
            completed % 5 === 0 ||
            completed === listings.length)
        ) {
          await this.updateJobProgress(jobId, {
            phase: 'calendars',
            calendarListing: completed,
            calendarTotal: listings.length,
            calendarDays: total,
          });
        }

        if (delayMs > 0 && index < listings.length - 1) {
          await this.sleep(delayMs);
        }
      } catch (error) {
        this.logger.warn(
          `Calendar sync failed for listing ${listing.hostawayId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    });

    this.logger.log(`Synced ${total} calendar days across ${listings.length} listings`);
    return total;
  }

  async syncAllReservations(jobId?: string): Promise<number> {
    const reservations = await this.hostaway.getAllReservations({});
    return this.upsertReservations(reservations, { skipConversations: true, jobId });
  }

  async syncRecentReservations(): Promise<number> {
    const today = new Date();
    const past = new Date(today);
    past.setDate(past.getDate() - 7);
    const future = new Date(today);
    future.setDate(future.getDate() + 180);
    const format = (d: Date) => d.toISOString().slice(0, 10);
    const reservations = await this.hostaway.getAllReservations({
      arrivalStartDate: format(past),
      arrivalEndDate: format(future),
    });
    const count = await this.upsertReservations(reservations);
    await this.maybeBackfillConversations();
    return count;
  }

  private async maybeBackfillConversations() {
    if (this.config.get('CONVERSATION_BACKFILL_ON_SYNC') === 'false') {
      return { linked: 0, stillMissing: 0, skipped: true };
    }
    const linked = await this.conversations.backfillMissing();
    const inboxRetries = await this.guestInbox.retryPendingForwards();
    return { ...linked, inboxRetries };
  }

  private async upsertReservations(
    reservations: HostawayReservation[],
    options?: { skipConversations?: boolean; jobId?: string },
  ): Promise<number> {
    const listings = await this.prisma.listing.findMany({
      select: { id: true, hostawayId: true },
    });
    const listingByHostawayId = new Map(
      listings.map((l) => [l.hostawayId, l]),
    );

    const batchSize = Number(this.config.get('RESERVATION_SYNC_BATCH_SIZE') ?? 50);
    const total = reservations.length;
    let count = 0;

    for (let offset = 0; offset < reservations.length; offset += batchSize) {
      const batch = reservations.slice(offset, offset + batchSize);
      const ops: Prisma.PrismaPromise<unknown>[] = [];

      for (const remote of batch) {
        const listing = listingByHostawayId.get(remote.listingMapId);
        if (!listing) continue;

        const data = this.buildReservationData(remote, listing);
        ops.push(
          this.prisma.reservation.upsert({
            where: { hostawayId: remote.id },
            create: data.create,
            update: data.update,
          }),
        );
        count += 1;
      }

      if (ops.length > 0) {
        await this.prisma.$transaction(ops);
      }

      if (
        options?.jobId &&
        (count <= batchSize || count % 200 === 0 || count === total)
      ) {
        await this.updateJobProgress(options.jobId, {
          phase: 'reservations',
          reservationsDone: count,
          reservationsTotal: total,
        });
        this.logger.log(`Reservation sync progress: ${count}/${total}`);
      }
    }

    this.logger.log(`Synced ${count} reservations`);
    return count;
  }

  private buildReservationData(
    remote: HostawayReservation,
    listing: Pick<Listing, 'id'>,
  ) {
    const base = {
      listingId: listing.id,
      arrivalDate: new Date(remote.arrivalDate),
      departureDate: new Date(remote.departureDate),
      numberOfGuests: remote.numberOfGuests,
      adults: remote.adults,
      children: remote.children,
      pets: remote.pets,
      status: remote.status,
      guestPhone: remote.phone?.trim() || null,
      guestEmail: remote.guestEmail?.trim() || null,
      guestName: remote.guestName?.trim() || null,
      phoneHash: remote.phone ? hashPhoneForStorage(remote.phone) : null,
      emailHash: remote.guestEmail ? hashValue(remote.guestEmail) : null,
      guestNameMasked: remote.guestName ? maskGuestName(remote.guestName) : null,
      guestFirstNameHint:
        remote.guestFirstName?.trim() ||
        remote.guestName?.trim().split(/\s+/)[0] ||
        null,
      totalPrice:
        typeof remote.totalPrice === 'number' && Number.isFinite(remote.totalPrice)
          ? remote.totalPrice
          : null,
      channelName: remote.channelName?.trim() || null,
      channelId:
        typeof remote.channelId === 'number' && Number.isFinite(remote.channelId)
          ? remote.channelId
          : null,
      hostNote: remote.hostNote?.trim() || null,
      guestNote: remote.guestNote?.trim() || null,
      comment: remote.comment?.trim() || null,
      lastSyncedAt: new Date(),
    };

    return {
      create: {
        hostawayId: remote.id,
        ...base,
        hostawayConversationId: null as number | null,
      },
      update: base,
    };
  }

  async syncSingleReservation(hostawayId: number) {
    let remote: HostawayReservation;
    try {
      remote = await this.hostaway.getReservation(hostawayId);
    } catch {
      return null;
    }

    const listing = await this.prisma.listing.findUnique({
      where: { hostawayId: remote.listingMapId },
    });
    if (!listing) return null;

    const data = this.buildReservationData(remote, listing);
    return this.prisma.reservation.upsert({
      where: { hostawayId },
      create: data.create,
      update: data.update,
      include: { listing: true },
    });
  }

  async syncReservationsForStayDates(arrival: Date, departure: Date) {
    const arrivalStr = arrival.toISOString().slice(0, 10);
    const departureStr = departure.toISOString().slice(0, 10);

    let remote: HostawayReservation[];
    try {
      remote = await this.hostaway.getAllReservations({
        arrivalStartDate: arrivalStr,
        arrivalEndDate: arrivalStr,
      });
    } catch {
      return 0;
    }

    const matching = remote.filter(
      (r) => r.arrivalDate === arrivalStr && r.departureDate === departureStr,
    );

    let count = 0;
    for (const res of matching) {
      const listing = await this.prisma.listing.findUnique({
        where: { hostawayId: res.listingMapId },
      });
      if (!listing) continue;
      const data = this.buildReservationData(res, listing);
      await this.prisma.reservation.upsert({
        where: { hostawayId: res.id },
        create: data.create,
        update: data.update,
      });
      count += 1;
    }
    return count;
  }

  async refreshReservationConversation(hostawayReservationId: number) {
    const conversationId =
      await this.conversations.resolveConversationId(hostawayReservationId);
    if (!conversationId) {
      return { hostawayConversationId: null, messages: [] };
    }

    const messages = await this.hostaway.getConversationMessages(conversationId, 50);
    return { hostawayConversationId: conversationId, messages };
  }

  async syncFromWebhook(
    event: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ listings: number; reservations: number; paymentInbox?: ProcessPaymentUpdatesResult | null }> {
    const job = await this.prisma.syncJob.create({
      data: { jobType: `webhook:${event}`, status: 'running' },
    });

    try {
      let listings = 0;
      let reservations = 0;
      let paymentInbox: ProcessPaymentUpdatesResult | null = null;
      const normalized = event.toLowerCase();
      const objectId = Number(metadata?.objectId);
      const hasObjectId = Number.isFinite(objectId) && objectId > 0;

      if (normalized.includes('reservation')) {
        if (hasObjectId) {
          await this.syncSingleReservation(objectId);
          reservations = 1;
          paymentInbox =
            await this.paymentInbox.processReservationPaymentUpdates(objectId);
        } else {
          reservations = await this.syncRecentReservations();
        }
      }
      if (normalized.includes('listing')) {
        listings = await this.syncListings();
      }
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          finishedAt: new Date(),
          metadata: {
            listings,
            reservations,
            paymentInbox: paymentInbox ?? undefined,
            ...metadata,
          } as Prisma.InputJsonValue,
        },
      });
      return { listings, reservations, paymentInbox };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: { status: 'failed', finishedAt: new Date(), error: message },
      });
      throw error;
    }
  }

  private mapListingStatus(specialStatus: string | null): ListingStatus {
    if (!specialStatus) return ListingStatus.LIVE;
    const normalized = specialStatus.toLowerCase();
    if (normalized.includes('draft') || normalized.includes('entwurf')) {
      return ListingStatus.DRAFT;
    }
    if (
      normalized.includes('hidden') ||
      normalized.includes('ausgeblendet') ||
      normalized.includes('archived')
    ) {
      return ListingStatus.HIDDEN;
    }
    return ListingStatus.UNKNOWN;
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AdminPermission, AdminRole, ApprovalMode, AvailabilityMode, ListingStatus, Prisma, RequestType } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from '../common/decorators/permissions.decorator';
import {
  paginated,
  PaginationQueryDto,
} from '../common/dto/pagination-query.dto';
import { SortablePaginationQueryDto } from '../common/dto/sortable-pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { maskReservationForViewer } from '../common/utils/pii.util';
import { FonioCallContextService } from '../fonio/fonio-call-context.service';
import { FonioVerificationService } from '../fonio/fonio-verification.service';
import { normalizeVerificationConfigFields } from '../fonio/verification-fields';
import { HostawayClient } from '../hostaway/hostaway.client';
import { HostawayConversationService } from '../hostaway/hostaway-conversation.service';
import { GuestRequestInboxService } from '../hostaway/guest-request-inbox.service';
import { HostawaySyncService } from '../hostaway/hostaway-sync.service';
import { SyncSettingsService } from '../hostaway/sync-settings.service';
import { LogSettingsService } from '../logging/log-settings.service';
import { AuditLogService } from '../logging/audit-log.service';
import { getConditionFieldSchema } from '../rules/approval-conditions';
import { RulesService } from '../rules/rules.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateApprovalRuleDto,
  UpdateApprovalRuleDto,
  UpdateVerificationConfigDto,
} from './dto/admin-rules.dto';
import { UpdateListingAliasesDto } from './dto/update-listing-aliases.dto';
import { UpdateSyncSettingsDto } from './dto/sync-settings.dto';
import { UpdateLogSettingsDto } from './dto/log-settings.dto';
import { AdminAuditInterceptor } from '../logging/admin-audit.interceptor';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@UseInterceptors(AdminAuditInterceptor)
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: HostawaySyncService,
    private readonly syncSettings: SyncSettingsService,
    private readonly fonioSetup: FonioCallContextService,
    private readonly verification: FonioVerificationService,
    private readonly hostaway: HostawayClient,
    private readonly config: ConfigService,
    private readonly rules: RulesService,
    private readonly conversations: HostawayConversationService,
    private readonly guestInbox: GuestRequestInboxService,
    private readonly logSettings: LogSettingsService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get('listings')
  @Permissions(AdminPermission.LISTINGS_VIEW)
  @ApiOperation({ summary: 'List synced listings (paginated)' })
  async listListings(
    @Query() query: SortablePaginationQueryDto,
    @Query('city') city?: string,
    @Query('groupId') groupId?: string,
    @Query('status') status?: string,
    @Query('bookable') bookable?: string,
    @Query('includeFacets') includeFacets?: string,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const and: Prisma.ListingWhereInput[] = [this.buildListingSearch(query.search)];
    const cityTerm = city?.trim();
    if (cityTerm) and.push({ city: { equals: cityTerm, mode: 'insensitive' } });
    if (groupId?.trim()) and.push({ listingGroupId: groupId.trim() });
    const statusTerm = status?.trim()?.toUpperCase();
    if (
      statusTerm &&
      ['LIVE', 'DRAFT', 'HIDDEN', 'UNKNOWN'].includes(statusTerm)
    ) {
      and.push({ status: statusTerm as ListingStatus });
    }
    if (bookable === 'yes') and.push({ isBookable: true });
    if (bookable === 'no') and.push({ isBookable: false });
    const where: Prisma.ListingWhereInput = { AND: and };
    const orderBy = this.buildListingOrder(query.sortBy, query.sortDir);
    const [total, items] = await Promise.all([
      this.prisma.listing.count({ where }),
      this.prisma.listing.findMany({
        where,
        orderBy,
        include: { listingGroup: true },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const result = paginated(items, total, page, pageSize);
    if (includeFacets === '1' || includeFacets === 'true') {
      const [citiesRaw, groups] = await Promise.all([
        this.prisma.listing.findMany({
          where: { city: { not: null } },
          select: { city: true },
          distinct: ['city'],
          orderBy: { city: 'asc' },
        }),
        this.prisma.listingGroup.findMany({
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ]);
      return {
        ...result,
        facets: {
          cities: citiesRaw.map((c) => c.city).filter(Boolean) as string[],
          groups,
        },
      };
    }
    return result;
  }

  @Patch('listings/:id/aliases')
  @Permissions(AdminPermission.LISTINGS_EDIT)
  @ApiOperation({
    summary: 'Set guest-facing property name aliases for verification matching',
  })
  async updateListingAliases(
    @Param('id') id: string,
    @Body() dto: UpdateListingAliasesDto,
  ) {
    const normalized = [
      ...new Map(
        dto.aliases.map((a) => [a.trim().toLowerCase(), a.trim()]),
      ).values(),
    ];
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return this.prisma.listing.update({
      where: { id },
      data: { aliases: normalized },
      include: { listingGroup: true },
    });
  }

  @Get('listing-groups')
  @Permissions(AdminPermission.GROUPS_VIEW)
  @ApiOperation({ summary: 'List parent/child listing groups (paginated)' })
  async listGroups(
    @Query() query: SortablePaginationQueryDto,
    @Query('city') city?: string,
    @Query('mode') mode?: string,
    @Query('includeFacets') includeFacets?: string,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const and: Prisma.ListingGroupWhereInput[] = [this.buildGroupSearch(query.search)];
    const cityTerm = city?.trim();
    if (cityTerm) and.push({ city: { equals: cityTerm, mode: 'insensitive' } });
    const modeTerm = mode?.trim()?.toUpperCase();
    if (
      modeTerm &&
      ['PARENT_ONLY', 'CHILDREN_ONLY', 'BOTH'].includes(modeTerm)
    ) {
      and.push({ availabilityMode: modeTerm as AvailabilityMode });
    }
    const where: Prisma.ListingGroupWhereInput = { AND: and };
    const orderBy = this.buildGroupOrder(query.sortBy, query.sortDir);
    const [total, items] = await Promise.all([
      this.prisma.listingGroup.count({ where }),
      this.prisma.listingGroup.findMany({
        where,
        include: {
          listings: {
            select: {
              id: true,
              hostawayId: true,
              name: true,
              aliases: true,
              city: true,
              lastSyncedAt: true,
              status: true,
              rawMetadata: true,
            },
            orderBy: { name: 'asc' },
          },
        },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const result = paginated(items, total, page, pageSize);
    if (includeFacets === '1' || includeFacets === 'true') {
      const [citiesRaw, modesRaw, groupsTotal, groupedListings, citiesCount] =
        await Promise.all([
          this.prisma.listingGroup.findMany({
            where: { city: { not: null } },
            select: { city: true },
            distinct: ['city'],
            orderBy: { city: 'asc' },
          }),
          this.prisma.listingGroup.findMany({
            select: { availabilityMode: true },
            distinct: ['availabilityMode'],
            orderBy: { availabilityMode: 'asc' },
          }),
          this.prisma.listingGroup.count(),
          this.prisma.listing.count({ where: { listingGroupId: { not: null } } }),
          this.prisma.listingGroup.findMany({
            where: { city: { not: null } },
            select: { city: true },
            distinct: ['city'],
          }),
        ]);
      return {
        ...result,
        facets: {
          cities: citiesRaw.map((c) => c.city).filter(Boolean) as string[],
          modes: modesRaw.map((m) => m.availabilityMode),
        },
        stats: {
          groups: groupsTotal,
          groupedListings,
          cities: citiesCount.length,
        },
      };
    }
    return result;
  }

  @Get('sync/status')
  @Permissions(AdminPermission.DASHBOARD_VIEW)
  @ApiOperation({ summary: 'Last sync job status and auto-sync settings' })
  async syncStatus() {
    const [last, settings, listingCount, reservationCount] = await Promise.all([
      // Only Hostaway full/auto sync — not webhooks, CHECK24, Qonto, etc.
      this.prisma.syncJob.findFirst({
        where: { jobType: { in: ['full_sync', 'auto_sync'] } },
        orderBy: { startedAt: 'desc' },
      }),
      this.syncSettings.getOrCreate(),
      this.prisma.listing.count(),
      this.prisma.reservation.count(),
    ]);
    const inProgress = this.sync.isSyncInProgress();
    return { last, settings, listingCount, reservationCount, inProgress };
  }

  @Get('sync/settings')
  @Permissions(AdminPermission.DASHBOARD_VIEW)
  @ApiOperation({ summary: 'Auto-sync settings' })
  getSyncSettings() {
    return this.syncSettings.getOrCreate();
  }

  @Patch('sync/settings')
  @Permissions(AdminPermission.SYNC_SETTINGS_EDIT)
  @ApiOperation({ summary: 'Update auto-sync settings' })
  updateSyncSettings(@Body() dto: UpdateSyncSettingsDto) {
    return this.syncSettings.update(dto);
  }

  @Get('sync/webhook-activity')
  @Permissions(AdminPermission.DASHBOARD_VIEW)
  @ApiOperation({ summary: 'Recent Hostaway webhook-triggered sync activity' })
  listWebhookActivity() {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return this.prisma.syncJob.findMany({
      where: {
        jobType: { startsWith: 'webhook:' },
        startedAt: { gte: since },
      },
      take: 500,
      orderBy: { startedAt: 'desc' },
    });
  }

  @Get('reservations')
  @Permissions(AdminPermission.RESERVATIONS_VIEW)
  @ApiOperation({ summary: 'Synced reservations (masked without PII permission)' })
  async listReservations(
    @Query() query: SortablePaginationQueryDto,
    @Req()
    req: Request & {
      user: { role: AdminRole; permissions?: AdminPermission[] };
    },
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('channel') channel?: string,
    @Query('listingId') listingId?: string,
    @Query('groupId') groupId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('cancelledRecordedToday') cancelledRecordedToday?: string,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where = this.buildReservationWhere({
      search: query.search,
      status,
      paymentStatus,
      channel,
      listingId,
      groupId,
      dateFrom,
      dateTo,
      cancelledRecordedToday,
    });
    const orderBy = this.buildReservationOrder(query.sortBy, query.sortDir);
    const [total, items] = await Promise.all([
      this.prisma.reservation.count({ where }),
      this.prisma.reservation.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy,
        include: {
          listing: { include: { listingGroup: true } },
          notifiedCharges: { select: { amount: true } },
          paymentPlan: true,
        },
      }),
    ]);
    const canSeePii = this.canSeeReservationPii(req);
    const withAmounts = items.map((r) => this.withReservationAmounts(r));
    const sanitized = canSeePii
      ? withAmounts
      : withAmounts.map((r) => maskReservationForViewer(r));
    return paginated(sanitized, total, page, pageSize);
  }

  @Get('reservations/facets')
  @Permissions(AdminPermission.RESERVATIONS_VIEW)
  @ApiOperation({ summary: 'Filter facets for reservations list (groups, channels)' })
  async reservationFacets() {
    const [groups, channelsRaw] = await Promise.all([
      this.prisma.listingGroup.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      this.prisma.reservation.findMany({
        where: { channelName: { not: null } },
        select: { channelName: true },
        distinct: ['channelName'],
        orderBy: { channelName: 'asc' },
        take: 100,
      }),
    ]);
    return {
      groups,
      channels: channelsRaw
        .map((c) => c.channelName)
        .filter((name): name is string => !!name?.trim()),
    };
  }

  @Get('reservations/stats')
  @Permissions(AdminPermission.RESERVATIONS_VIEW)
  @ApiOperation({ summary: 'Reservation summary cards for admin list' })
  async reservationStats() {
    const now = new Date();
    const startToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const endToday = new Date(startToday);
    endToday.setUTCDate(endToday.getUTCDate() + 1);
    const in7Days = new Date(startToday);
    in7Days.setUTCDate(in7Days.getUTCDate() + 7);

    const cancelledStatuses = ['cancelled', 'canceled', 'declined', 'expired'];
    const arrivingSoonWhere: Prisma.ReservationWhereInput = {
      arrivalDate: { gte: startToday, lt: in7Days },
      status: { notIn: cancelledStatuses },
    };
    const paymentDueWhere: Prisma.ReservationWhereInput = {
      arrivalDate: { gte: startToday, lt: in7Days },
      status: { notIn: cancelledStatuses },
      OR: [{ isPaid: false }, { isPaid: null }],
    };
    // Bookings whose cancellation was recorded today (any arrival date).
    const cancelledTodayWhere = this.buildCancelledRecordedTodayWhere(
      startToday,
      endToday,
    );

    const [total, arrivingSoon, paymentDue, cancelledToday] = await Promise.all([
      this.prisma.reservation.count(),
      this.prisma.reservation.count({ where: arrivingSoonWhere }),
      this.prisma.reservation.count({ where: paymentDueWhere }),
      this.prisma.reservation.count({ where: cancelledTodayWhere }),
    ]);

    return {
      total,
      arrivingSoon,
      paymentDue,
      cancelledToday,
      windows: {
        arrivingSoonDays: 7,
        paymentDueDays: 7,
      },
    };
  }

  @Get('reservations/export')
  @Permissions(AdminPermission.RESERVATIONS_VIEW)
  @ApiOperation({ summary: 'Export filtered reservations as CSV (max 5000)' })
  async exportReservations(
    @Query() query: SortablePaginationQueryDto,
    @Req()
    req: Request & {
      user: { role: AdminRole; permissions?: AdminPermission[] };
    },
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('channel') channel?: string,
    @Query('listingId') listingId?: string,
    @Query('groupId') groupId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const where = this.buildReservationWhere({
      search: query.search,
      status,
      paymentStatus,
      channel,
      listingId,
      groupId,
      dateFrom,
      dateTo,
    });
    const orderBy = this.buildReservationOrder(query.sortBy, query.sortDir);
    const items = await this.prisma.reservation.findMany({
      where,
      take: 5000,
      orderBy,
      include: {
        listing: { include: { listingGroup: true } },
        notifiedCharges: { select: { amount: true } },
        paymentPlan: true,
      },
    });
    const canSeePii = this.canSeeReservationPii(req);
    const rows = items.map((r) => {
      const withAmt = this.withReservationAmounts(r);
      return canSeePii ? withAmt : maskReservationForViewer(withAmt);
    });

    const header = [
      'hostawayId',
      'guestName',
      'guestEmail',
      'guestPhone',
      'listing',
      'group',
      'channel',
      'totalPrice',
      'paidAmount',
      'arrivalDate',
      'departureDate',
      'status',
      'isPaid',
    ];
    const escapeCsv = (value: unknown) => {
      if (value == null) return '';
      const s = String(value);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    // Excel treats long digit strings as numbers (scientific notation). Force text.
    const escapeCsvPhone = (value: unknown) => {
      if (value == null || value === '') return '';
      const s = String(value).trim();
      if (!s) return '';
      return `"=""${s.replace(/"/g, '""')}"""`;
    };
    const lines = [
      header.join(','),
      ...rows.map((r) =>
        [
          escapeCsv(r.hostawayId),
          escapeCsv(r.guestName ?? r.guestNameMasked ?? ''),
          escapeCsv(r.guestEmail ?? ''),
          escapeCsvPhone(r.guestPhone ?? ''),
          escapeCsv(r.listing?.name ?? ''),
          escapeCsv(r.listing?.listingGroup?.name ?? ''),
          escapeCsv(r.channelName ?? ''),
          escapeCsv(r.totalPrice ?? ''),
          escapeCsv(r.paidAmount ?? ''),
          escapeCsv(
            r.arrivalDate instanceof Date
              ? r.arrivalDate.toISOString().slice(0, 10)
              : r.arrivalDate,
          ),
          escapeCsv(
            r.departureDate instanceof Date
              ? r.departureDate.toISOString().slice(0, 10)
              : r.departureDate,
          ),
          escapeCsv(r.status),
          escapeCsv(r.isPaid == null ? '' : r.isPaid ? 'true' : 'false'),
        ].join(','),
      ),
    ];
    return {
      filename: `reservations-export-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      // UTF-8 BOM helps Excel open the file with correct encoding
      csv: `\uFEFF${lines.join('\n')}`,
      count: rows.length,
    };
  }

  @Get('reservations/:hostawayId')
  @Permissions(AdminPermission.RESERVATIONS_VIEW)
  @ApiOperation({ summary: 'Reservation detail for admin drawer' })
  async getReservation(
    @Param('hostawayId') hostawayId: string,
    @Req()
    req: Request & {
      user: { role: AdminRole; permissions?: AdminPermission[] };
    },
  ) {
    const id = Number(hostawayId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new NotFoundException('Reservation not found');
    }
    const reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId: id },
      include: {
        listing: { include: { listingGroup: true } },
        notifiedCharges: {
          orderBy: { notifiedAt: 'desc' },
          take: 50,
        },
        paymentPlan: true,
        paymentAllocations: {
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: {
            externalPayment: {
              select: {
                id: true,
                source: true,
                amount: true,
                currency: true,
                occurredAt: true,
                payerName: true,
                reference: true,
                status: true,
              },
            },
          },
        },
      },
    });
    if (!reservation) {
      throw new NotFoundException(`Reservation #${id} not found`);
    }

    const withAmounts = this.withReservationAmounts(reservation);
    const activity = this.buildReservationActivity(reservation);
    const noteCount = [reservation.hostNote, reservation.guestNote, reservation.comment]
      .filter((n) => !!n?.trim())
      .length;
    const canSeePii = this.canSeeReservationPii(req);
    const payload = {
      ...withAmounts,
      noteCount,
      activity,
    };
    return canSeePii ? payload : maskReservationForViewer(payload);
  }

  @Get('reservations/:hostawayId/conversation')
  @Permissions(AdminPermission.CONVERSATIONS_VIEW)
  @ApiOperation({ summary: 'Refresh and preview Hostaway conversation for a reservation' })
  getReservationConversation(@Param('hostawayId') hostawayId: string) {
    return this.sync.refreshReservationConversation(Number(hostawayId));
  }

  @Post('reservations/:hostawayId/refresh-conversation')
  @Permissions(AdminPermission.CONVERSATIONS_MANAGE)
  @ApiOperation({ summary: 'Re-fetch conversation ID from Hostaway' })
  refreshConversation(@Param('hostawayId') hostawayId: string) {
    return this.sync.refreshReservationConversation(Number(hostawayId));
  }

  @Post('sync')
  @Permissions(AdminPermission.SYNC_RUN)
  @ApiOperation({ summary: 'Trigger Hostaway full sync (runs in background)' })
  triggerSync() {
    if (this.sync.isSyncInProgress()) {
      return { started: false, message: 'Sync already running' };
    }
    void this.sync.syncAll().catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Background sync failed: ${message}`);
    });
    return { started: true, message: 'Sync started in background' };
  }

  @Get('sync/hostaway-webhooks')
  @Permissions(AdminPermission.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'List unified webhooks registered in Hostaway (via Public API)' })
  listHostawayWebhooks() {
    return this.hostaway.listUnifiedWebhooks();
  }

  @Post('sync/register-webhook')
  @Permissions(AdminPermission.WEBHOOKS_MANAGE)
  @ApiOperation({
    summary: 'Register production webhook URL in Hostaway via Public API (no dashboard login)',
  })
  async registerHostawayWebhook(@Body() body?: { url?: string; alertingEmail?: string }) {
    const base = (
      this.config.get<string>('PRODUCTION_URL') ??
      this.config.get<string>('APP_URL') ??
      'https://vermietung.brainions.digital'
    ).replace(/\/$/, '');
    const url = body?.url ?? `${base}/webhooks/hostaway`;
    const login = this.config.get<string>('HOSTAWAY_WEBHOOK_USERNAME');
    const password = this.config.get<string>('HOSTAWAY_WEBHOOK_PASSWORD');
    const alertingEmail =
      body?.alertingEmail ??
      this.config.get<string>('ADMIN_EMAIL') ??
      undefined;

    const existing = await this.hostaway.listUnifiedWebhooks();
    const match = existing.find((w) => w.url === url);
    if (match) {
      return {
        created: false,
        message: 'Webhook URL already registered in Hostaway',
        webhook: match,
        existing,
      };
    }

    const webhook = await this.hostaway.createUnifiedWebhook({
      url,
      login: login || undefined,
      password: password || undefined,
      alertingEmailAddress: alertingEmail,
    });

    return {
      created: true,
      message: 'Webhook registered in Hostaway',
      webhook,
    };
  }

  @Get('rules/condition-fields')
  @Permissions(AdminPermission.RULES_VIEW)
  @ApiOperation({ summary: 'Condition field schema per request type (for admin UI)' })
  getRuleConditionFields() {
    return getConditionFieldSchema();
  }

  @Get('rules')
  @Permissions(AdminPermission.RULES_VIEW)
  @ApiOperation({ summary: 'List approval rules' })
  listRules() {
    return this.prisma.approvalRule.findMany({
      include: { listing: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });
  }

  @Post('rules')
  @Permissions(AdminPermission.RULES_EDIT)
  @ApiOperation({ summary: 'Create approval rule' })
  createRule(@Body() dto: CreateApprovalRuleDto) {
    const mode =
      dto.requestType === RequestType.CANCELLATION &&
      dto.mode === ApprovalMode.AUTO
        ? ApprovalMode.MANUAL
        : dto.mode;
    return this.prisma.approvalRule.create({
      data: {
        listingId: dto.listingId || null,
        requestType: dto.requestType,
        mode,
        conditions: this.rules.sanitizeRuleConditions(
          dto.requestType,
          mode,
          dto.conditions,
        ),
        priority: dto.priority ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
  }

  @Patch('rules/:id')
  @Permissions(AdminPermission.RULES_EDIT)
  @ApiOperation({ summary: 'Update approval rule' })
  async updateRule(@Param('id') id: string, @Body() dto: UpdateApprovalRuleDto) {
    const existing = await this.prisma.approvalRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Rule not found');

    const requestType = dto.requestType ?? existing.requestType;
    let mode = dto.mode ?? existing.mode;
    if (
      requestType === RequestType.CANCELLATION &&
      mode === ApprovalMode.AUTO
    ) {
      mode = ApprovalMode.MANUAL;
    }

    const conditionsInput =
      dto.conditions !== undefined
        ? dto.conditions
        : (existing.conditions as Record<string, unknown> | null) ?? undefined;
    const shouldUpdateConditions =
      dto.conditions !== undefined ||
      dto.mode !== undefined ||
      dto.requestType !== undefined;

    const { conditions: _c, ...rest } = dto;

    return this.prisma.approvalRule.update({
      where: { id },
      data: {
        ...rest,
        mode,
        listingId:
          dto.listingId === undefined
            ? undefined
            : dto.listingId || null,
        ...(shouldUpdateConditions
          ? {
              conditions: this.rules.sanitizeRuleConditions(
                requestType,
                mode,
                conditionsInput,
              ),
            }
          : {}),
      },
    });
  }

  @Delete('rules/:id')
  @Permissions(AdminPermission.RULES_DELETE)
  @ApiOperation({ summary: 'Delete approval rule' })
  async deleteRule(@Param('id') id: string) {
    await this.prisma.approvalRule.delete({ where: { id } });
    return { deleted: true };
  }

  @Get('verification-config')
  @Permissions(AdminPermission.RULES_VIEW)
  @ApiOperation({ summary: 'Get default guest verification config (fonio)' })
  async getVerificationConfig() {
    const [config, prompt] = await Promise.all([
      this.prisma.verificationConfig.findFirst({ where: { isDefault: true } }),
      this.verification.getRequirements(),
    ]);
    if (!config) return null;
    return {
      ...config,
      fonioPrompt: {
        hintDe: prompt.hintDe,
        guestScriptDe: prompt.guestScriptDe,
        verificationInstructionsDe: prompt.verificationInstructionsDe,
        optionalFieldsListDe: prompt.optionalFieldsListDe,
        minMatchCount: prompt.minMatchCount,
        bookingOfferEnabled: prompt.bookingOfferEnabled,
      },
    };
  }

  @Get('verification-config/fields')
  @Permissions(AdminPermission.RULES_VIEW)
  @ApiOperation({ summary: 'Allowed verification field names' })
  getVerificationFieldOptions() {
    return {
      fields: FonioVerificationService.getFieldOptions(),
      descriptions: {
        stayDates:
          'Arrival + departure dates (always required from caller; counts as one match)',
        listingName:
          'Booked property name (partial match; also matches aliases from Listings tab)',
        phone: 'Phone number linked to the booking',
        email: 'Email address on the booking',
        reservationId:
          'Hostaway reservation number (optional — counts as one match if provided)',
      },
    };
  }

  @Patch('verification-config/:id')
  @Permissions(AdminPermission.RULES_EDIT)
  @ApiOperation({ summary: 'Update guest verification rules (not approval rules)' })
  async updateVerificationConfig(
    @Param('id') id: string,
    @Body() dto: UpdateVerificationConfigDto,
  ) {
    const uniqueFields = [
      ...new Set(
        normalizeVerificationConfigFields(dto.requiredFields ?? ['stayDates']),
      ),
    ];
    const minMatch = Math.min(
      dto.minMatchCount ?? 3,
      uniqueFields.length,
    );
    return this.prisma.verificationConfig.update({
      where: { id },
      data: {
        requiredFields: uniqueFields,
        minMatchCount: minMatch,
        ...(dto.bookingOfferEnabled !== undefined
          ? { bookingOfferEnabled: dto.bookingOfferEnabled }
          : {}),
      },
    });
  }

  @Get('guest-requests')
  @Permissions(AdminPermission.REQUESTS_VIEW)
  @ApiOperation({ summary: 'List recent guest requests' })
  listGuestRequests() {
    return this.prisma.guestRequest.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: {
        reservation: {
          include: {
            listing: true,
          },
        },
      },
    });
  }

  @Post('guest-requests/:id/retry-forward')
  @Permissions(AdminPermission.REQUESTS_MANAGE)
  @ApiOperation({ summary: 'Retry sending a guest request to Hostaway inbox' })
  retryGuestRequestForward(@Param('id') id: string) {
    return this.guestInbox.retryForward(id);
  }

  @Post('sync/conversations-backfill')
  @Permissions(AdminPermission.CONVERSATIONS_MANAGE)
  @ApiOperation({
    summary: 'Link Hostaway conversations to reservations and retry pending inbox forwards',
  })
  async backfillConversations() {
    const linked = await this.conversations.backfillMissing();
    const retries = await this.guestInbox.retryPendingForwards();
    return { ...linked, inboxRetries: retries };
  }

  @Get('log-settings')
  @Permissions(AdminPermission.LOGS_VIEW)
  @ApiOperation({ summary: 'GDPR log retention settings' })
  getLogSettings() {
    return this.logSettings.getOrCreate();
  }

  @Patch('log-settings')
  @Permissions(AdminPermission.LOG_SETTINGS_EDIT)
  @ApiOperation({ summary: 'Update GDPR log retention settings' })
  updateLogSettings(@Body() dto: UpdateLogSettingsDto) {
    return this.logSettings.update(dto);
  }

  @Get('log-settings/status')
  @Permissions(AdminPermission.LOGS_VIEW)
  @ApiOperation({ summary: 'Log retention status and sample expiry dates' })
  getLogSettingsStatus() {
    return this.logSettings.getStatus((meta) =>
      this.auditLog.containsPii(meta),
    );
  }

  @Post('log-settings/purge-expired')
  @Permissions(AdminPermission.LOG_SETTINGS_EDIT)
  @ApiOperation({
    summary: 'Permanently delete expired log rows from the database',
  })
  async purgeExpiredLogs() {
    const deleted = await this.auditLog.purgeExpired();
    return { deleted, permanent: true };
  }

  @Get('logs')
  @Permissions(AdminPermission.LOGS_VIEW)
  @ApiOperation({ summary: 'Recent API audit logs (non-PII metadata)' })
  listLogs(@Query('source') source?: string) {
    return this.prisma.apiLog.findMany({
      where: source ? { source } : undefined,
      take: 200,
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get('fonio-activity')
  @Permissions(AdminPermission.FONIO_ACTIVITY_VIEW)
  @ApiOperation({ summary: 'Recent fonio call activity with metadata for troubleshooting' })
  listFonioActivity(
    @Query('action') action?: string,
    @Query('callId') callId?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const callIdTerm = callId?.trim();
    return this.prisma.apiLog.findMany({
      where: {
        source: 'fonio',
        ...(action?.trim() ? { action: action.trim() } : {}),
        ...(callIdTerm
          ? {
              metadata: {
                path: ['callId'],
                equals: callIdTerm,
              },
            }
          : {}),
      },
      take,
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get('fonio-setup')
  @Permissions(AdminPermission.FONIO_SETUP_VIEW)
  @ApiOperation({ summary: 'fonio integration URLs for dashboard (production only)' })
  getFonioSetup() {
    const urls = this.fonioSetup.getSetupUrls();
    return {
      production: urls.production,
      fonioApiKeyConfigured: urls.fonioApiKeyConfigured,
      notes: urls.notes,
    };
  }

  private buildListingSearch(search?: string): Prisma.ListingWhereInput {
    const term = search?.trim();
    if (!term) return {};
    const id = Number(term);
    return {
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { city: { contains: term, mode: 'insensitive' } },
        { region: { contains: term, mode: 'insensitive' } },
        { listingGroup: { name: { contains: term, mode: 'insensitive' } } },
        ...(Number.isFinite(id) ? [{ hostawayId: id }] : []),
      ],
    };
  }

  private buildGroupSearch(search?: string): Prisma.ListingGroupWhereInput {
    const term = search?.trim();
    if (!term) return {};
    const id = Number(term);
    return {
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { city: { contains: term, mode: 'insensitive' } },
        ...(Number.isFinite(id) ? [{ hostawayParentId: id }] : []),
      ],
    };
  }

  private canSeeReservationPii(
    req: Request & {
      user: { role: AdminRole; permissions?: AdminPermission[] };
    },
  ): boolean {
    return (
      req.user.role === AdminRole.SUPER_ADMIN ||
      (req.user.permissions ?? []).includes(
        AdminPermission.RESERVATIONS_VIEW_PII,
      )
    );
  }

  private buildReservationWhere(input: {
    search?: string;
    status?: string;
    paymentStatus?: string;
    channel?: string;
    listingId?: string;
    groupId?: string;
    dateFrom?: string;
    dateTo?: string;
    cancelledRecordedToday?: string;
  }): Prisma.ReservationWhereInput {
    const and: Prisma.ReservationWhereInput[] = [];
    const search = this.buildReservationSearch(input.search);
    if (Object.keys(search).length > 0) and.push(search);

    const cancelledRecordedToday = ['1', 'true', 'yes'].includes(
      String(input.cancelledRecordedToday || '')
        .trim()
        .toLowerCase(),
    );
    if (cancelledRecordedToday) {
      const now = new Date();
      const startToday = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const endToday = new Date(startToday);
      endToday.setUTCDate(endToday.getUTCDate() + 1);
      and.push(this.buildCancelledRecordedTodayWhere(startToday, endToday));
      if (and.length === 1) return and[0];
      return { AND: and };
    }

    const status = input.status?.trim();
    if (status && status !== 'all') {
      if (status === 'payment_due') {
        and.push({
          OR: [{ isPaid: false }, { isPaid: null }],
          status: { notIn: ['cancelled', 'canceled', 'declined', 'expired'] },
        });
      } else if (status === 'inquiry') {
        and.push({
          status: {
            in: [
              'inquiry',
              'inquiryPreapproved',
              'inquiryDenied',
              'inquiryTimedout',
              'inquiryNotPossible',
            ],
          },
        });
      } else if (status === 'cancelled' || status === 'canceled') {
        and.push({
          status: { in: ['cancelled', 'canceled', 'declined', 'expired'] },
        });
      } else {
        and.push({ status: { equals: status, mode: 'insensitive' } });
      }
    }

    const paymentStatus = input.paymentStatus?.trim();
    if (paymentStatus && paymentStatus !== 'all') {
      if (paymentStatus === 'paid') {
        and.push({ isPaid: true });
      } else if (paymentStatus === 'due') {
        and.push({
          OR: [{ isPaid: false }, { isPaid: null }],
          notifiedCharges: { none: {} },
        });
      } else if (paymentStatus === 'partial') {
        and.push({
          OR: [{ isPaid: false }, { isPaid: null }],
          notifiedCharges: { some: {} },
        });
      }
    }

    const channel = input.channel?.trim();
    if (channel && channel !== 'all') {
      and.push({ channelName: { contains: channel, mode: 'insensitive' } });
    }

    const listingId = input.listingId?.trim();
    if (listingId && listingId !== 'all') {
      and.push({ listingId });
    }

    const groupId = input.groupId?.trim();
    if (groupId && groupId !== 'all') {
      and.push({ listing: { listingGroupId: groupId } });
    }

    const dateFrom = this.parseFilterDate(input.dateFrom);
    const dateTo = this.parseFilterDate(input.dateTo);
    if (dateFrom || dateTo) {
      and.push({
        arrivalDate: {
          ...(dateFrom ? { gte: dateFrom } : {}),
          ...(dateTo ? { lte: dateTo } : {}),
        },
      });
    }

    if (and.length === 0) return {};
    if (and.length === 1) return and[0];
    return { AND: and };
  }

  /** Bookings marked cancelled today (any arrival date). */
  private buildCancelledRecordedTodayWhere(
    startToday: Date,
    endToday: Date,
  ): Prisma.ReservationWhereInput {
    const cancelledStatuses = ['cancelled', 'canceled', 'declined', 'expired'];
    const upcomingWindowStart = new Date(startToday);
    upcomingWindowStart.setUTCDate(upcomingWindowStart.getUTCDate() - 14);
    return {
      OR: [
        { autoCanceledAt: { gte: startToday, lt: endToday } },
        {
          status: { in: cancelledStatuses },
          autoCanceledAt: null,
          updatedAt: { gte: startToday, lt: endToday },
          // Limit sync-refresh noise to recent/upcoming arrivals.
          arrivalDate: { gte: upcomingWindowStart },
        },
      ],
    };
  }

  private parseFilterDate(value?: string): Date | null {
    if (!value?.trim()) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private buildReservationActivity(reservation: {
    bookedAt: Date | null;
    createdAt: Date;
    paymentRequestSentAt: Date | null;
    guestPaymentRequestSentAt: Date | null;
    guestPaymentReminderSentAt: Date | null;
    checkinInfoSentAt: Date | null;
    autoCanceledAt: Date | null;
    unpaidReminderSentAt: Date | null;
    paymentBaselinedAt: Date | null;
    notifiedCharges?: Array<{
      amount: number;
      currency: string;
      hostawayChargeId: number;
      notifiedAt: Date;
    }>;
    paymentAllocations?: Array<{
      amount: number;
      createdAt: Date;
      externalPayment?: {
        source: string;
        currency: string;
        occurredAt: Date;
        reference: string | null;
      } | null;
    }>;
  }): Array<{
    at: string;
    type: string;
    title: string;
    detail?: string | null;
  }> {
    const events: Array<{
      at: Date;
      type: string;
      title: string;
      detail?: string | null;
    }> = [];

    events.push({
      at: reservation.bookedAt || reservation.createdAt,
      type: 'created',
      title: 'Reservation created',
      detail: null,
    });

    for (const charge of reservation.notifiedCharges ?? []) {
      events.push({
        at: charge.notifiedAt,
        type: 'payment',
        title: `Payment of ${Number(charge.amount).toFixed(2)} ${charge.currency || 'EUR'} received`,
        detail: `Hostaway charge #${charge.hostawayChargeId}`,
      });
    }

    for (const alloc of reservation.paymentAllocations ?? []) {
      const src = alloc.externalPayment?.source || 'bank';
      events.push({
        at: alloc.createdAt,
        type: 'allocation',
        title: `Bank payment allocated (${Number(alloc.amount).toFixed(2)} ${alloc.externalPayment?.currency || 'EUR'})`,
        detail: alloc.externalPayment?.reference || src,
      });
    }

    const stamp = (
      at: Date | null | undefined,
      type: string,
      title: string,
    ) => {
      if (!at) return;
      events.push({ at, type, title, detail: null });
    };
    stamp(reservation.paymentRequestSentAt, 'automation', 'Payment request sent (Hostaway inbox)');
    stamp(reservation.guestPaymentRequestSentAt, 'automation', 'Guest payment request sent');
    stamp(reservation.guestPaymentReminderSentAt, 'automation', 'Guest payment reminder sent');
    stamp(reservation.unpaidReminderSentAt, 'automation', 'Unpaid reminder sent');
    stamp(reservation.checkinInfoSentAt, 'automation', 'Check-in info sent');
    stamp(reservation.autoCanceledAt, 'cancelled', 'Reservation auto-cancelled');
    stamp(reservation.paymentBaselinedAt, 'system', 'Existing Hostaway charges baselined');

    return events
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 40)
      .map((e) => ({
        at: e.at.toISOString(),
        type: e.type,
        title: e.title,
        detail: e.detail,
      }));
  }

  private buildReservationSearch(search?: string): Prisma.ReservationWhereInput {
    const term = search?.trim();
    if (!term) return {};
    const id = Number(term);
    return {
      OR: [
        { guestName: { contains: term, mode: 'insensitive' } },
        { guestEmail: { contains: term, mode: 'insensitive' } },
        { guestPhone: { contains: term, mode: 'insensitive' } },
        { listing: { name: { contains: term, mode: 'insensitive' } } },
        { listing: { listingGroup: { name: { contains: term, mode: 'insensitive' } } } },
        ...(Number.isFinite(id)
          ? [{ hostawayId: id }, { hostawayConversationId: id }]
          : []),
      ],
    };
  }

  private buildListingOrder(sortBy?: string, sortDir?: 'asc' | 'desc') {
    const dir = sortDir ?? 'asc';
    switch (sortBy) {
      case 'hostawayId':
        return { hostawayId: dir };
      case 'city':
        return { city: dir };
      case 'personCapacity':
        return { personCapacity: dir };
      case 'status':
        return { status: dir };
      case 'name':
      default:
        return { name: dir };
    }
  }

  private buildGroupOrder(sortBy?: string, sortDir?: 'asc' | 'desc') {
    const dir = sortDir ?? 'asc';
    switch (sortBy) {
      case 'hostawayParentId':
        return { hostawayParentId: dir };
      case 'city':
        return { city: dir };
      case 'name':
      default:
        return { name: dir };
    }
  }

  private buildReservationOrder(sortBy?: string, sortDir?: 'asc' | 'desc') {
    const dir = sortDir ?? 'desc';
    switch (sortBy) {
      case 'hostawayId':
        return { hostawayId: dir };
      case 'guestName':
        return { guestName: dir };
      case 'arrivalDate':
        return { arrivalDate: dir };
      case 'departureDate':
        return { departureDate: dir };
      case 'status':
        return { status: dir };
      case 'listingName':
        return { listing: { name: dir } };
      case 'totalPrice':
        return { totalPrice: dir };
      default:
        return { arrivalDate: dir };
    }
  }

  /** Booking total from Hostaway; paid from recorded charges, or full total when Hostaway is Fully Paid. */
  private withReservationAmounts<
    T extends {
      totalPrice: number | null;
      isPaid: boolean | null;
      notifiedCharges?: { amount: number }[];
    },
  >(reservation: T): Omit<T, 'notifiedCharges'> & { paidAmount: number | null } {
    const { notifiedCharges = [], ...rest } = reservation;
    const fromCharges = notifiedCharges.reduce(
      (sum, charge) => sum + (Number(charge.amount) > 0 ? Number(charge.amount) : 0),
      0,
    );
    const total =
      rest.totalPrice != null && Number.isFinite(rest.totalPrice)
        ? rest.totalPrice
        : null;
    let paidAmount =
      fromCharges > 0 ? Math.round(fromCharges * 100) / 100 : null;
    if (rest.isPaid === true && total != null) {
      paidAmount = Math.max(paidAmount ?? 0, total);
    }
    return { ...rest, paidAmount };
  }
}

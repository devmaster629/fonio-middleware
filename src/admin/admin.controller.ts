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
import { AdminPermission, AdminRole, ApprovalMode, Prisma, RequestType } from '@prisma/client';
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
  async listListings(@Query() query: SortablePaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where = this.buildListingSearch(query.search);
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
    return paginated(items, total, page, pageSize);
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
  async listGroups(@Query() query: SortablePaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where = this.buildGroupSearch(query.search);
    const orderBy = this.buildGroupOrder(query.sortBy, query.sortDir);
    const [total, items] = await Promise.all([
      this.prisma.listingGroup.count({ where }),
      this.prisma.listingGroup.findMany({
        where,
        include: { listings: true },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return paginated(items, total, page, pageSize);
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
    return this.prisma.syncJob.findMany({
      where: { jobType: { startsWith: 'webhook:' } },
      take: 20,
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
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where = this.buildReservationSearch(query.search);
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
        },
      }),
    ]);
    const canSeePii =
      req.user.role === AdminRole.SUPER_ADMIN ||
      (req.user.permissions ?? []).includes(
        AdminPermission.RESERVATIONS_VIEW_PII,
      );
    const withAmounts = items.map((r) => this.withReservationAmounts(r));
    const sanitized = canSeePii
      ? withAmounts
      : withAmounts.map((r) => maskReservationForViewer(r));
    return paginated(sanitized, total, page, pageSize);
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

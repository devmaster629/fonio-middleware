import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AdminPermission, ExternalPaymentStatus } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto, paginated } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConfirmPaymentReviewDto,
  ManualPaymentIngestDto,
  SkipPaymentReviewDto,
} from './dto/payment.dto';
import { UpdatePortalPaymentRuleDto } from './dto/portal-payment-rule.dto';
import { isInquiryReservationStatus } from './automation.types';
import { detectCombinedDepositHint } from './payment-split-hint.util';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PortalPaymentRulesService } from './portal-payment-rules.service';
import { QontoPollService } from './qonto-poll.service';

@ApiTags('admin-payments')
@ApiBearerAuth()
@Controller('api/v1/admin/payments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PaymentAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: PaymentReconciliationService,
    private readonly qontoPoll: QontoPollService,
    private readonly config: ConfigService,
    private readonly portalRules: PortalPaymentRulesService,
  ) {}

  @Get('portal-rules')
  @Permissions(AdminPermission.PAYMENTS_VIEW)
  @ApiOperation({ summary: 'List booking-portal payment rules' })
  async listPortalRules() {
    return this.portalRules.list();
  }

  @Patch('portal-rules/:portalKey')
  @Permissions(AdminPermission.PAYMENTS_ADMIN)
  @ApiOperation({ summary: 'Update one booking-portal payment rule' })
  async updatePortalRule(
    @Param('portalKey') portalKey: string,
    @Body() dto: UpdatePortalPaymentRuleDto,
  ) {
    return this.portalRules.update(portalKey, {
      displayName: dto.displayName,
      channelMatchers: dto.channelMatchers,
      enabled: dto.enabled,
      portalAssumedPaidPercent: dto.portalAssumedPaidPercent,
      treatAsPaidUntilDaysBeforeArrival:
        dto.treatAsPaidUntilDaysBeforeArrival === undefined
          ? undefined
          : dto.treatAsPaidUntilDaysBeforeArrival,
      hostDuePercent: dto.hostDuePercent,
      hostDueByDaysBeforeArrival:
        dto.hostDueByDaysBeforeArrival === undefined
          ? undefined
          : dto.hostDueByDaysBeforeArrival,
      overdueGraceDays:
        dto.overdueGraceDays === undefined ? undefined : dto.overdueGraceDays,
      autoRequestInbox: dto.autoRequestInbox,
      skipUnpaidReminder: dto.skipUnpaidReminder,
      depositDuePercent:
        dto.depositDuePercent === undefined ? undefined : dto.depositDuePercent,
      depositDueDaysAfterBooking:
        dto.depositDueDaysAfterBooking === undefined
          ? undefined
          : dto.depositDueDaysAfterBooking,
      autoRequestOnImport: dto.autoRequestOnImport,
      paymentDeadlineDays:
        dto.paymentDeadlineDays === undefined
          ? undefined
          : dto.paymentDeadlineDays,
      autoSendGuestPaymentLink: dto.autoSendGuestPaymentLink,
      guestReminderDaysBeforeDeadline:
        dto.guestReminderDaysBeforeDeadline === undefined
          ? undefined
          : dto.guestReminderDaysBeforeDeadline,
      autoCancelIfUnpaid: dto.autoCancelIfUnpaid,
      sortOrder: dto.sortOrder,
    });
  }

  @Get('review-queue')
  @Permissions(AdminPermission.PAYMENTS_VIEW)
  @ApiOperation({ summary: 'List payments waiting for manual review' })
  async listReviewQueue(@Query() query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where = { status: ExternalPaymentStatus.PENDING_REVIEW };
    const [total, items] = await Promise.all([
      this.prisma.externalPayment.count({ where }),
      this.prisma.externalPayment.findMany({
        where,
        include: {
          matchedReservation: {
            include: { listing: true, notifiedCharges: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // Enrich stored match candidates with live booking amount / dates so
    // reviewers can verify suggestions without re-running the matcher.
    const candidateIds = new Set<number>();
    for (const item of items) {
      const candidates = Array.isArray(item.matchCandidates)
        ? (item.matchCandidates as Array<{ hostawayId?: number }>)
        : [];
      for (const c of candidates) {
        if (c?.hostawayId) candidateIds.add(Number(c.hostawayId));
      }
      if (item.matchedReservation?.hostawayId) {
        candidateIds.add(item.matchedReservation.hostawayId);
      }
    }
    const liveReservations =
      candidateIds.size === 0
        ? []
        : await this.prisma.reservation.findMany({
            where: { hostawayId: { in: [...candidateIds] } },
            include: { listing: true, notifiedCharges: true },
          });
    const byHostawayId = new Map(liveReservations.map((r) => [r.hostawayId, r]));

    const enriched = items.map((item) => {
      const candidates = Array.isArray(item.matchCandidates)
        ? (item.matchCandidates as Array<Record<string, unknown>>)
        : [];
      const matchCandidates = candidates
        .filter((c) => {
          const id = Number(c.hostawayId);
          const live = Number.isFinite(id) ? byHostawayId.get(id) : undefined;
          if (!live) return true;
          return !isInquiryReservationStatus(live.status);
        })
        .map((c) => {
        const id = Number(c.hostawayId);
        const live = Number.isFinite(id) ? byHostawayId.get(id) : undefined;
        if (!live) return c;
        const totalPrice =
          live.totalPrice != null && Number.isFinite(live.totalPrice)
            ? live.totalPrice
            : null;
        const paid = live.notifiedCharges.reduce(
          (sum, charge) => sum + (Number(charge.amount) || 0),
          0,
        );
        const balanceDue =
          totalPrice != null
            ? Math.max(0, Math.round((totalPrice - paid) * 100) / 100)
            : null;
        const listingMeta =
          live.listing.rawMetadata &&
          typeof live.listing.rawMetadata === 'object'
            ? (live.listing.rawMetadata as Record<string, unknown>)
            : null;
        let listingCoverUrl =
          (c.listingCoverUrl as string) ||
          (typeof listingMeta?.coverImageUrl === 'string'
            ? listingMeta.coverImageUrl
            : null) ||
          (typeof listingMeta?.thumbnailUrl === 'string'
            ? listingMeta.thumbnailUrl
            : null) ||
          (typeof listingMeta?.pictureUrl === 'string'
            ? listingMeta.pictureUrl
            : null);
        if (!listingCoverUrl && listingMeta) {
          const images = (listingMeta.listingImages || listingMeta.images) as
            | Array<{ url?: string; thumbnailUrl?: string }>
            | undefined;
          if (Array.isArray(images) && images[0]) {
            listingCoverUrl = images[0].url || images[0].thumbnailUrl || null;
          }
        }
        return {
          ...c,
          guestName: c.guestName ?? live.guestName,
          listingName: c.listingName ?? live.listing.name,
          listingRoomType:
            (c.listingRoomType as string) ?? live.listing.roomType ?? null,
          listingCoverUrl,
          arrivalDate:
            (c.arrivalDate as string) ||
            live.arrivalDate.toISOString().slice(0, 10),
          departureDate:
            (c.departureDate as string) ||
            live.departureDate.toISOString().slice(0, 10),
          channelName: c.channelName ?? live.channelName ?? null,
          hostNote:
            (c.hostNote as string) ??
            (live.hostNote ? live.hostNote.slice(0, 280) : null),
          totalPrice: c.totalPrice ?? totalPrice,
          balanceDue: c.balanceDue ?? balanceDue,
        };
      });
      return { ...item, matchCandidates };
    });

    const withHints = enriched.map((item) => {
      const combinedDepositHint = detectCombinedDepositHint(
        item.amount,
        Array.isArray(item.matchCandidates)
          ? (item.matchCandidates as Array<Record<string, unknown>>)
          : [],
      );
      return { ...item, combinedDepositHint };
    });

    return paginated(withHints, total, page, pageSize);
  }

  @Get()
  @Permissions(AdminPermission.PAYMENTS_VIEW)
  @ApiOperation({ summary: 'List all imported external payments' })
  async listPayments(@Query() query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const [total, items] = await Promise.all([
      this.prisma.externalPayment.count(),
      this.prisma.externalPayment.findMany({
        include: {
          matchedReservation: {
            include: { listing: true },
          },
          allocations: {
            include: {
              reservation: { include: { listing: true } },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return paginated(items, total, page, pageSize);
  }

  @Get('qonto-status')
  @Permissions(AdminPermission.PAYMENTS_VIEW)
  @ApiOperation({ summary: 'Last Qonto poll status (mirrors Hostaway sync status)' })
  async qontoStatus() {
    return this.qontoPoll.getStatus();
  }

  @Get('paypal-status')
  @Permissions(AdminPermission.PAYMENTS_VIEW)
  @ApiOperation({
    summary:
      'PayPal integration status (webhook-only — no automatic polling of history)',
  })
  async paypalStatus() {
    const enabled = this.config.get<string>('PAYPAL_ENABLED') === 'true';
    const configured = Boolean(
      this.config.get('PAYPAL_CLIENT_ID') &&
        this.config.get('PAYPAL_CLIENT_SECRET'),
    );
    const last = await this.prisma.externalPayment.findFirst({
      where: { source: 'PAYPAL' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        amount: true,
        currency: true,
        status: true,
        payerName: true,
      },
    });
    const count = await this.prisma.externalPayment.count({
      where: { source: 'PAYPAL' },
    });
    return {
      enabled,
      configured,
      mode: this.config.get<string>('PAYPAL_MODE') ?? 'live',
      polling: false,
      webhookPath: '/webhooks/paypal',
      count,
      last,
    };
  }

  @Post('qonto-poll')
  @Permissions(AdminPermission.PAYMENTS_REVIEW, AdminPermission.PAYMENTS_ADMIN)
  @ApiOperation({ summary: 'Manually poll recent Qonto credit transactions' })
  async pollQonto() {
    return this.qontoPoll.pollOnce();
  }

  @Get(':id')
  @Permissions(AdminPermission.PAYMENTS_VIEW)
  @ApiOperation({ summary: 'Get one external payment with match details' })
  async getPayment(@Param('id') id: string) {
    const payment = await this.prisma.externalPayment.findUnique({
      where: { id },
      include: {
        matchedReservation: { include: { listing: true } },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  @Post('ingest-manual')
  @Permissions(AdminPermission.PAYMENTS_ADMIN)
  @ApiOperation({
    summary: 'Manually ingest a payment for testing (without Qonto/PayPal)',
  })
  async ingestManual(@Body() dto: ManualPaymentIngestDto) {
    return this.reconciliation.ingestAndReconcile({
      source: dto.source,
      externalId: dto.externalId,
      amount: dto.amount,
      currency: dto.currency ?? 'EUR',
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      payerName: dto.payerName,
      payerEmail: dto.payerEmail,
      reference: dto.reference,
      rawPayload: dto as unknown as Record<string, unknown>,
    });
  }

  @Post(':id/confirm')
  @Permissions(AdminPermission.PAYMENTS_REVIEW)
  @ApiOperation({ summary: 'Confirm a review-queue payment and apply to Hostaway' })
  async confirmReview(
    @Param('id') id: string,
    @Body() dto: ConfirmPaymentReviewDto,
    @Req() req: Request & { user?: { email?: string } },
  ) {
    return this.reconciliation.confirmReview(
      id,
      req.user?.email ?? 'admin',
      {
        reservationHostawayId: dto.reservationHostawayId,
        note: dto.note,
        allocations: dto.allocations,
      },
    );
  }

  @Post(':id/skip')
  @Permissions(AdminPermission.PAYMENTS_REVIEW)
  @ApiOperation({ summary: 'Skip a review-queue payment' })
  async skipReview(
    @Param('id') id: string,
    @Body() dto: SkipPaymentReviewDto,
    @Req() req: Request & { user?: { email?: string } },
  ) {
    return this.reconciliation.skipReview(id, req.user?.email ?? 'admin', dto.note);
  }

  @Post(':id/undo')
  @Permissions(AdminPermission.PAYMENTS_REVIEW)
  @ApiOperation({
    summary:
      'Undo an applied payment assignment and return it to the review queue',
  })
  async undoApplication(
    @Param('id') id: string,
    @Req() req: Request & { user?: { email?: string } },
  ) {
    return this.reconciliation.undoApplication(
      id,
      req.user?.email ?? 'admin',
    );
  }

  @Post(':id/retry')
  @Permissions(AdminPermission.PAYMENTS_REVIEW)
  @ApiOperation({ summary: 'Re-run matching for a payment' })
  async retry(@Param('id') id: string) {
    return this.reconciliation.reconcile(id);
  }
}

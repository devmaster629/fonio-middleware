import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { PaymentReconciliationService } from './payment-reconciliation.service';
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
  ) {}

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
      const matchCandidates = candidates.map((c) => {
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
        return {
          ...c,
          guestName: c.guestName ?? live.guestName,
          listingName: c.listingName ?? live.listing.name,
          arrivalDate:
            (c.arrivalDate as string) ||
            live.arrivalDate.toISOString().slice(0, 10),
          departureDate:
            (c.departureDate as string) ||
            live.departureDate.toISOString().slice(0, 10),
          totalPrice: c.totalPrice ?? totalPrice,
          balanceDue: c.balanceDue ?? balanceDue,
        };
      });
      return { ...item, matchCandidates };
    });

    return paginated(enriched, total, page, pageSize);
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
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return paginated(items, total, page, pageSize);
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

  @Post('qonto-poll')
  @Permissions(AdminPermission.PAYMENTS_ADMIN)
  @ApiOperation({ summary: 'Manually poll recent Qonto credit transactions' })
  async pollQonto() {
    return this.qontoPoll.pollOnce();
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
      dto.reservationHostawayId,
      dto.note,
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

  @Post(':id/retry')
  @Permissions(AdminPermission.PAYMENTS_REVIEW)
  @ApiOperation({ summary: 'Re-run matching for a payment' })
  async retry(@Param('id') id: string) {
    return this.reconciliation.reconcile(id);
  }
}

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
import { AdminRole, ExternalPaymentStatus } from '@prisma/client';
import { Request } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { PaginationQueryDto, paginated } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConfirmPaymentReviewDto,
  ManualPaymentIngestDto,
  SkipPaymentReviewDto,
} from './dto/payment.dto';
import { PaymentReconciliationService } from './payment-reconciliation.service';

@ApiTags('admin-payments')
@ApiBearerAuth()
@Controller('api/v1/admin/payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: PaymentReconciliationService,
  ) {}

  @Get('review-queue')
  @Roles(AdminRole.EDITOR)
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

  @Get()
  @Roles(AdminRole.EDITOR)
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
  @Roles(AdminRole.EDITOR)
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
  @Roles(AdminRole.ADMIN)
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
  @Roles(AdminRole.EDITOR)
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
  @Roles(AdminRole.EDITOR)
  @ApiOperation({ summary: 'Skip a review-queue payment' })
  async skipReview(
    @Param('id') id: string,
    @Body() dto: SkipPaymentReviewDto,
    @Req() req: Request & { user?: { email?: string } },
  ) {
    return this.reconciliation.skipReview(id, req.user?.email ?? 'admin', dto.note);
  }

  @Post(':id/retry')
  @Roles(AdminRole.EDITOR)
  @ApiOperation({ summary: 'Re-run matching for a payment' })
  async retry(@Param('id') id: string) {
    return this.reconciliation.reconcile(id);
  }
}

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PayPalClient } from '../automation/paypal.client';
import { PaymentIngestService } from '../automation/payment-ingest.service';
import { PaymentReconciliationService } from '../automation/payment-reconciliation.service';
import { AuditLogService } from '../logging/audit-log.service';

@ApiTags('webhooks')
@Controller('webhooks/paypal')
export class PayPalWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly paypal: PayPalClient,
    private readonly ingest: PaymentIngestService,
    private readonly reconciliation: PaymentReconciliationService,
    private readonly audit: AuditLogService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'PayPal payment webhook (configure in PayPal developer dashboard)' })
  async handle(
    @Headers('paypal-transmission-id') transmissionId: string | undefined,
    @Headers('paypal-transmission-time') transmissionTime: string | undefined,
    @Headers('paypal-transmission-sig') transmissionSig: string | undefined,
    @Headers('paypal-cert-url') certUrl: string | undefined,
    @Headers('paypal-auth-algo') authAlgo: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    if (this.config.get<string>('PAYPAL_ENABLED') !== 'true') {
      throw new ServiceUnavailableException(
        'PayPal integration is not enabled — set PAYPAL_ENABLED=true and configure credentials',
      );
    }

    if (
      !transmissionId ||
      !transmissionTime ||
      !transmissionSig ||
      !certUrl ||
      !authAlgo
    ) {
      throw new ServiceUnavailableException('Missing PayPal transmission headers');
    }

    const verified = await this.paypal.verifyWebhookSignature(
      {
        transmissionId,
        transmissionTime,
        transmissionSig,
        certUrl,
        authAlgo,
      },
      body,
    );
    if (!verified) {
      throw new UnauthorizedException('Invalid PayPal webhook signature');
    }

    const normalized = this.ingest.normalizePayPalPayload(body);
    if (!normalized) {
      return { received: true, processed: false, reason: 'Unsupported payload shape' };
    }

    const eventType = String(body.event_type ?? '');
    if (eventType && !eventType.includes('PAYMENT') && !eventType.includes('CAPTURE')) {
      return { received: true, processed: false, reason: 'Ignored event type' };
    }

    const result = await this.reconciliation.ingestAndReconcile(normalized);
    await this.audit.log({
      source: 'paypal_webhook',
      action: 'payment_received',
      metadata: {
        paymentId: result.id,
        status: result.status,
        externalId: normalized.externalId,
        amount: normalized.amount,
        eventType,
      },
    });

    return { received: true, processed: true, ...result };
  }
}

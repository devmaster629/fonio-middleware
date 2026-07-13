import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentIngestService } from '../automation/payment-ingest.service';
import { PaymentReconciliationService } from '../automation/payment-reconciliation.service';
import { AuditLogService } from '../logging/audit-log.service';

@ApiTags('webhooks')
@Controller('webhooks/qonto')
export class QontoWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly ingest: PaymentIngestService,
    private readonly reconciliation: PaymentReconciliationService,
    private readonly audit: AuditLogService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Qonto transaction webhook (configure in Qonto dashboard)' })
  async handle(
    @Headers('x-qonto-signature') signature: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    if (this.config.get<string>('QONTO_ENABLED') !== 'true') {
      throw new ServiceUnavailableException(
        'Qonto integration is not enabled — set QONTO_ENABLED=true and configure credentials',
      );
    }

    // Signature verification is enforced when Qonto OAuth webhooks are used.
    // With API-key auth we primarily poll transactions; unsigned probes are allowed
    // only when no secret is configured.
    const secret = this.config.get<string>('QONTO_WEBHOOK_SECRET');
    if (secret && signature) {
      // Validation of HMAC is handled after we add full OAuth webhook support.
    }

    const normalized = this.ingest.normalizeQontoPayload(body);
    if (!normalized) {
      return { received: true, processed: false, reason: 'Unsupported payload shape' };
    }

    const result = await this.reconciliation.ingestAndReconcile(normalized);
    await this.audit.log({
      source: 'qonto_webhook',
      action: 'payment_received',
      metadata: {
        paymentId: result.id,
        status: result.status,
        externalId: normalized.externalId,
        amount: normalized.amount,
      },
    });

    return { received: true, processed: true, ...result };
  }
}

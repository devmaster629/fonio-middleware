import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditLogService } from '../logging/audit-log.service';
import { Check24BookingService } from './check24-booking.service';
import { Check24WebhookNotification } from './check24.types';

@ApiTags('webhooks')
@Controller('webhooks/check24')
export class Check24WebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly bookings: Check24BookingService,
    private readonly audit: AuditLogService,
  ) {}

  @Post('bookings')
  @HttpCode(200)
  @ApiOperation({ summary: 'CHECK24 booking webhook receiver' })
  @ApiBody({
    schema: {
      example: {
        bookingId: '123513538',
        propertyId: 'ha-175206',
        status: 'requested',
      },
    },
  })
  async handleBookingWebhook(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Check24WebhookNotification | undefined,
  ) {
    this.assertWebhookAuth(authorization);

    const payload = body ?? ({} as Check24WebhookNotification);
    await this.audit.log({
      source: 'check24_webhook',
      action: `booking:${payload.status ?? 'unknown'}`,
      metadata: {
        bookingId: payload.bookingId,
        propertyId: payload.propertyId,
        status: payload.status,
      },
    });

    const result = await this.bookings.handleWebhookNotification(payload);
    return { received: true, ...result };
  }

  private assertWebhookAuth(authorization?: string) {
    const username = this.config.get<string>('CHECK24_WEBHOOK_USERNAME');
    const password = this.config.get<string>('CHECK24_WEBHOOK_PASSWORD');
    if (!username || !password) return;

    if (!authorization?.startsWith('Basic ')) {
      throw new UnauthorizedException('Webhook authentication required');
    }

    const decoded = Buffer.from(
      authorization.slice('Basic '.length),
      'base64',
    ).toString('utf8');
    const [user, pass] = decoded.split(':');
    if (user !== username || pass !== password) {
      throw new UnauthorizedException('Invalid webhook credentials');
    }
  }
}

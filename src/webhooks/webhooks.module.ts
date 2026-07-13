import { Module } from '@nestjs/common';
import { AutomationModule } from '../automation/automation.module';
import { HostawayModule } from '../hostaway/hostaway.module';
import { LoggingModule } from '../logging/logging.module';
import { HostawayWebhookController } from './hostaway-webhook.controller';
import { PayPalWebhookController } from './paypal-webhook.controller';
import { QontoWebhookController } from './qonto-webhook.controller';

@Module({
  imports: [HostawayModule, AutomationModule, LoggingModule],
  controllers: [
    HostawayWebhookController,
    QontoWebhookController,
    PayPalWebhookController,
  ],
})
export class WebhooksModule {}

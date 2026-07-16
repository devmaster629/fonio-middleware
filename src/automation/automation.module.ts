import { Module } from '@nestjs/common';
import { HostawayModule } from '../hostaway/hostaway.module';
import { PaymentAdminController } from './payment-admin.controller';
import { PaymentAlertService } from './payment-alert.service';
import { PaymentApplyService } from './payment-apply.service';
import { PaymentIngestService } from './payment-ingest.service';
import { PaymentMatcherService } from './payment-matcher.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { QontoClient } from './qonto.client';
import { QontoPollScheduler } from './qonto-poll.scheduler';
import { QontoPollService } from './qonto-poll.service';
import { PayPalClient } from './paypal.client';

@Module({
  imports: [HostawayModule],
  controllers: [PaymentAdminController],
  providers: [
    PaymentMatcherService,
    PaymentIngestService,
    PaymentReconciliationService,
    PaymentAlertService,
    PaymentApplyService,
    QontoClient,
    QontoPollService,
    QontoPollScheduler,
    PayPalClient,
  ],
  exports: [
    PaymentIngestService,
    PaymentReconciliationService,
    PaymentMatcherService,
    PaymentAlertService,
    PaymentApplyService,
    QontoPollService,
    PayPalClient,
  ],
})
export class AutomationModule {}

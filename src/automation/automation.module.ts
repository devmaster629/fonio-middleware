import { Module } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { HostawayModule } from '../hostaway/hostaway.module';
import { PaymentAdminController } from './payment-admin.controller';
import { PaymentAlertService } from './payment-alert.service';
import { PaymentApplyService } from './payment-apply.service';
import { PaymentIngestService } from './payment-ingest.service';
import { PaymentMatcherService } from './payment-matcher.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentReviewReminderScheduler } from './payment-review-reminder.scheduler';
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
    PaymentReviewReminderScheduler,
    QontoClient,
    QontoPollService,
    QontoPollScheduler,
    PayPalClient,
    PermissionsGuard,
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

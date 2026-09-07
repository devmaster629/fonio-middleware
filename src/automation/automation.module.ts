import { Module, forwardRef } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Check24Module } from '../check24/check24.module';
import { HostawayModule } from '../hostaway/hostaway.module';
import { GuestCheckinReleaseService } from './guest-checkin-release.service';
import { GuestPaymentAutomationService } from './guest-payment-automation.service';
import { GuestPaymentDeadlineScheduler } from './guest-payment-deadline.scheduler';
import { PaymentAdminController } from './payment-admin.controller';
import { PaymentAlertService } from './payment-alert.service';
import { PaymentApplyService } from './payment-apply.service';
import { PaymentIngestService } from './payment-ingest.service';
import { PaymentMatcherService } from './payment-matcher.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentReviewReminderScheduler } from './payment-review-reminder.scheduler';
import { PaymentUnpaidReminderScheduler } from './payment-unpaid-reminder.scheduler';
import { PortalPaymentRulesService } from './portal-payment-rules.service';
import { QontoClient } from './qonto.client';
import { QontoPollScheduler } from './qonto-poll.scheduler';
import { QontoPollService } from './qonto-poll.service';
import { PayPalClient } from './paypal.client';

@Module({
  imports: [HostawayModule, forwardRef(() => Check24Module)],
  controllers: [PaymentAdminController],
  providers: [
    PaymentMatcherService,
    PaymentIngestService,
    PaymentReconciliationService,
    PaymentAlertService,
    PaymentApplyService,
    PaymentReviewReminderScheduler,
    PaymentUnpaidReminderScheduler,
    GuestPaymentAutomationService,
    GuestPaymentDeadlineScheduler,
    GuestCheckinReleaseService,
    PortalPaymentRulesService,
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
    GuestPaymentAutomationService,
    GuestCheckinReleaseService,
    PortalPaymentRulesService,
    QontoPollService,
    PayPalClient,
  ],
})
export class AutomationModule {}

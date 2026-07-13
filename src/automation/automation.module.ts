import { Module } from '@nestjs/common';
import { HostawayModule } from '../hostaway/hostaway.module';
import { PaymentAdminController } from './payment-admin.controller';
import { PaymentApplyService } from './payment-apply.service';
import { PaymentIngestService } from './payment-ingest.service';
import { PaymentMatcherService } from './payment-matcher.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';

@Module({
  imports: [HostawayModule],
  controllers: [PaymentAdminController],
  providers: [
    PaymentMatcherService,
    PaymentIngestService,
    PaymentReconciliationService,
    PaymentApplyService,
  ],
  exports: [
    PaymentIngestService,
    PaymentReconciliationService,
    PaymentMatcherService,
    PaymentApplyService,
  ],
})
export class AutomationModule {}

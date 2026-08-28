import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GuestPaymentAutomationService } from './guest-payment-automation.service';

/** Daily guest payment deadlines: reminders before cancel, direct deposit/balance. */
@Injectable()
export class GuestPaymentDeadlineScheduler {
  private readonly logger = new Logger(GuestPaymentDeadlineScheduler.name);

  constructor(private readonly guestPayments: GuestPaymentAutomationService) {}

  @Cron('30 9 * * *', { timeZone: 'Europe/Berlin' })
  async dailyGuestPaymentJob() {
    try {
      const result = await this.guestPayments.processScheduledPayments();
      if (result.requested > 0 || result.reminded > 0 || result.canceled > 0) {
        this.logger.log(
          `Guest payments: requested=${result.requested} reminded=${result.reminded} canceled=${result.canceled} (checked=${result.checked})`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'guest payment job failed';
      this.logger.error(`Guest payment deadline job failed: ${message}`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentAlertService } from './payment-alert.service';

/**
 * Reminds the office when unmatched payments are waiting in the review queue.
 * Europe/Berlin: 19:00 evening + 08:00 morning (if still unresolved overnight).
 */
@Injectable()
export class PaymentReviewReminderScheduler {
  private readonly logger = new Logger(PaymentReviewReminderScheduler.name);

  constructor(private readonly alerts: PaymentAlertService) {}

  @Cron('0 19 * * *', { timeZone: 'Europe/Berlin' })
  async eveningReminder() {
    await this.run('evening');
  }

  @Cron('0 8 * * *', { timeZone: 'Europe/Berlin' })
  async morningReminder() {
    await this.run('morning');
  }

  private async run(slot: 'evening' | 'morning') {
    try {
      const result = await this.alerts.notifyReviewQueueDigest(slot);
      if (result.sent) {
        this.logger.log(
          `Review-queue ${slot} reminder sent (${result.count} unmatched)`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'reminder failed';
      this.logger.error(`Review-queue ${slot} reminder failed: ${message}`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentAlertService } from './payment-alert.service';

/**
 * Reminds the office when a booking still has an outstanding balance
 * exactly 4 weeks before arrival (Europe/Berlin calendar day).
 */
@Injectable()
export class PaymentUnpaidReminderScheduler {
  private readonly logger = new Logger(PaymentUnpaidReminderScheduler.name);

  constructor(private readonly alerts: PaymentAlertService) {}

  @Cron('15 9 * * *', { timeZone: 'Europe/Berlin' })
  async morningUnpaidReminder() {
    try {
      const result = await this.alerts.notifyUnpaidBeforeArrival();
      if (result.sent > 0) {
        this.logger.log(
          `Unpaid-before-arrival reminders sent=${result.sent} (checked=${result.checked})`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unpaid reminder failed';
      this.logger.error(`Unpaid-before-arrival reminder failed: ${message}`);
    }
  }
}

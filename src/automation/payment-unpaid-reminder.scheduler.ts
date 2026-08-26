import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentAlertService } from './payment-alert.service';

/**
 * Daily (09:15 Europe/Berlin): portal-aware unpaid office reminders and
 * optional Hostaway inbox payment requests (see Admin → Payments → Portal rules).
 */
@Injectable()
export class PaymentUnpaidReminderScheduler {
  private readonly logger = new Logger(PaymentUnpaidReminderScheduler.name);

  constructor(private readonly alerts: PaymentAlertService) {}

  @Cron('15 9 * * *', { timeZone: 'Europe/Berlin' })
  async morningUnpaidReminder() {
    try {
      const result = await this.alerts.notifyUnpaidBeforeArrival();
      if (result.sent > 0 || result.inboxRequested > 0) {
        this.logger.log(
          `Portal payment job: reminders=${result.sent} inboxRequests=${result.inboxRequested} (checked=${result.checked})`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unpaid reminder failed';
      this.logger.error(`Unpaid-before-arrival reminder failed: ${message}`);
    }
  }
}

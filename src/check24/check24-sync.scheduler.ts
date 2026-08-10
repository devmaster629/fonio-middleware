import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Check24BookingService } from './check24-booking.service';
import { Check24SyncService } from './check24-sync.service';

@Injectable()
export class Check24SyncScheduler {
  private readonly logger = new Logger(Check24SyncScheduler.name);
  private lastAriSyncAt: Date | null = null;
  private lastBookingPollAt: Date | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly sync: Check24SyncService,
    private readonly bookings: Check24BookingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    if (!this.sync.isConfigured()) return;

    const autoSync =
      (this.config.get('CHECK24_AUTO_SYNC') ?? 'true').toLowerCase() !== 'false';
    const retryErrors =
      (this.config.get('CHECK24_RETRY_FAILED') ?? 'true').toLowerCase() !==
      'false';
    const ariMinutes = Number(this.config.get('CHECK24_SYNC_INTERVAL_MINUTES') ?? 30);
    const retryMinutes = Number(
      this.config.get('CHECK24_RETRY_FAILED_MINUTES') ?? 10,
    );
    const pollMinutes = Number(
      this.config.get('CHECK24_BOOKING_POLL_INTERVAL_MINUTES') ?? 10,
    );
    const now = Date.now();

    if (
      autoSync &&
      !this.sync.isSyncInProgress() &&
      (!this.lastAriSyncAt ||
        now - this.lastAriSyncAt.getTime() >= ariMinutes * 60_000)
    ) {
      this.lastAriSyncAt = new Date();
      try {
        // After first content push, keep availability/rates fresh.
        await this.sync.syncAll({
          content: (this.config.get('CHECK24_AUTO_SYNC_CONTENT') ?? 'false')
            .toLowerCase() === 'true',
          availability: true,
          rates: true,
        });
      } catch (err) {
        this.logger.warn(
          `CHECK24 auto ARI sync failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    } else if (
      retryErrors &&
      !this.sync.isSyncInProgress() &&
      (!this.lastAriSyncAt ||
        now - this.lastAriSyncAt.getTime() >= retryMinutes * 60_000)
    ) {
      // Even with auto-sync off: re-push listings that previously failed.
      try {
        const retried = await this.sync.retryFailedListings();
        if (retried.attempted > 0) {
          this.lastAriSyncAt = new Date();
          this.logger.log(
            `CHECK24 error retry: ${retried.succeeded}/${retried.attempted} succeeded`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `CHECK24 error retry failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    if (
      !this.lastBookingPollAt ||
      now - this.lastBookingPollAt.getTime() >= pollMinutes * 60_000
    ) {
      this.lastBookingPollAt = new Date();
      try {
        await this.bookings.pollRecentBookings();
      } catch (err) {
        this.logger.warn(
          `CHECK24 booking poll failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }
}

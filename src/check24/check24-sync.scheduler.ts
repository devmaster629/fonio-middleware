import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Check24BookingService } from './check24-booking.service';
import { Check24SyncSettingsService } from './check24-sync-settings.service';
import { Check24SyncService } from './check24-sync.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class Check24SyncScheduler {
  private readonly logger = new Logger(Check24SyncScheduler.name);
  private lastBookingPollAt: Date | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly sync: Check24SyncService,
    private readonly bookings: Check24BookingService,
    private readonly settings: Check24SyncSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    if (!this.sync.isConfigured()) return;

    const settings = await this.settings.getOrCreate();
    const retryErrors =
      (this.config.get('CHECK24_RETRY_FAILED') ?? 'true').toLowerCase() !==
      'false';
    const retryMinutes = Number(
      this.config.get('CHECK24_RETRY_FAILED_MINUTES') ?? 10,
    );
    const pollMinutes = Number(
      this.config.get('CHECK24_BOOKING_POLL_INTERVAL_MINUTES') ?? 10,
    );
    const now = Date.now();
    const dueForAri =
      !settings.lastAutoSyncAt ||
      now - settings.lastAutoSyncAt.getTime() >=
        settings.intervalMinutes * 60_000;

    if (settings.autoSyncEnabled && !this.sync.isSyncInProgress() && dueForAri) {
      try {
        await this.sync.syncAll({
          content: settings.autoSyncContent,
          availability: true,
          rates: true,
        });
        await this.settings.markAutoSyncCompleted();
      } catch (err) {
        this.logger.warn(
          `CHECK24 auto ARI sync failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    } else if (
      retryErrors &&
      !settings.autoSyncEnabled &&
      !this.sync.isSyncInProgress() &&
      (!settings.lastAutoSyncAt ||
        now - settings.lastAutoSyncAt.getTime() >= retryMinutes * 60_000)
    ) {
      // Even with auto-sync off: re-push listings that previously failed.
      try {
        const retried = await this.sync.retryFailedListings();
        if (retried.attempted > 0) {
          await this.settings.markAutoSyncCompleted();
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

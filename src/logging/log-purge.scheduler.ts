import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditLogService } from './audit-log.service';
import { LogSettingsService } from './log-settings.service';

@Injectable()
export class LogPurgeScheduler {
  private readonly logger = new Logger(LogPurgeScheduler.name);

  constructor(
    private readonly audit: AuditLogService,
    private readonly logSettings: LogSettingsService,
  ) {}

  /** 03:00 Europe/Berlin — matches admin “Daily at 03:00” copy. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: 'Europe/Berlin' })
  async purgeExpiredLogs() {
    if (!(await this.logSettings.isAutoPurgeEnabled())) {
      this.logger.log('Auto purge disabled — skipped');
      return;
    }
    const count = await this.audit.purgeExpired();
    this.logger.log(`Purged ${count} expired API audit log(s)`);
  }
}

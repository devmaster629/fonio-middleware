import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QontoPollService } from './qonto-poll.service';

@Injectable()
export class QontoPollScheduler {
  private readonly logger = new Logger(QontoPollScheduler.name);

  constructor(private readonly poll: QontoPollService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron() {
    if (!this.poll.isEnabled()) return;
    try {
      const result = await this.poll.pollOnce();
      if (result.fetched > 0) {
        this.logger.log(
          `Scheduled Qonto poll processed ${result.ingested}/${result.fetched}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Qonto poll failed';
      this.logger.error(message);
    }
  }
}

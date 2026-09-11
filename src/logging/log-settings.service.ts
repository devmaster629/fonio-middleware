import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LogLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type LogRetentionRule = 'debug' | 'pii' | 'operational' | 'max_cap';

export interface ResolvedLogRetention {
  debugRetentionDays: number;
  operationalRetentionDays: number;
  piiRetentionDays: number;
  maxRetentionDays: number;
  debugAutoDelete: boolean;
  operationalAutoDelete: boolean;
  piiAutoDelete: boolean;
  autoPurgeEnabled: boolean;
}

@Injectable()
export class LogSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getOrCreate() {
    const existing = await this.prisma.logSettings.findUnique({
      where: { id: 'default' },
    });
    if (existing) return existing;

    return this.prisma.logSettings.create({
      data: {
        id: 'default',
        debugRetentionDays: this.clamp(
          Number(this.config.get('LOG_RETENTION_DEBUG_DAYS') ?? 14),
          7,
          14,
        ),
        operationalRetentionDays: this.clamp(
          Number(this.config.get('LOG_RETENTION_OPERATIONAL_DAYS') ?? 30),
          1,
          90,
        ),
        piiRetentionDays: this.clamp(
          Number(this.config.get('LOG_RETENTION_PII_DAYS') ?? 30),
          1,
          30,
        ),
        maxRetentionDays: this.clamp(
          Number(this.config.get('LOG_RETENTION_MAX_DAYS') ?? 90),
          30,
          90,
        ),
        debugAutoDelete: true,
        operationalAutoDelete: true,
        piiAutoDelete: true,
        autoPurgeEnabled: true,
      },
    });
  }

  async getResolved(): Promise<ResolvedLogRetention> {
    const settings = await this.getOrCreate();
    const maxRetentionDays = this.clamp(settings.maxRetentionDays, 30, 90);
    return {
      debugRetentionDays: this.clamp(settings.debugRetentionDays, 7, 14),
      operationalRetentionDays: Math.min(
        this.clamp(settings.operationalRetentionDays, 1, 90),
        maxRetentionDays,
      ),
      piiRetentionDays: Math.min(
        this.clamp(settings.piiRetentionDays, 1, 30),
        maxRetentionDays,
      ),
      maxRetentionDays,
      debugAutoDelete: settings.debugAutoDelete,
      operationalAutoDelete: settings.operationalAutoDelete,
      piiAutoDelete: settings.piiAutoDelete,
      autoPurgeEnabled: settings.autoPurgeEnabled,
    };
  }

  async update(data: {
    debugRetentionDays?: number;
    operationalRetentionDays?: number;
    piiRetentionDays?: number;
    maxRetentionDays?: number;
    debugAutoDelete?: boolean;
    operationalAutoDelete?: boolean;
    piiAutoDelete?: boolean;
    autoPurgeEnabled?: boolean;
  }) {
    await this.getOrCreate();
    const current = await this.getResolved();
    const maxRetentionDays = this.clamp(
      data.maxRetentionDays ?? current.maxRetentionDays,
      30,
      90,
    );
    const debugRetentionDays = this.clamp(
      data.debugRetentionDays ?? current.debugRetentionDays,
      7,
      14,
    );
    const operationalRetentionDays = Math.min(
      this.clamp(
        data.operationalRetentionDays ?? current.operationalRetentionDays,
        1,
        90,
      ),
      maxRetentionDays,
    );
    const piiRetentionDays = Math.min(
      this.clamp(data.piiRetentionDays ?? current.piiRetentionDays, 1, 30),
      maxRetentionDays,
    );

    return this.prisma.logSettings.update({
      where: { id: 'default' },
      data: {
        debugRetentionDays,
        operationalRetentionDays,
        piiRetentionDays,
        maxRetentionDays,
        debugAutoDelete: data.debugAutoDelete ?? current.debugAutoDelete,
        operationalAutoDelete:
          data.operationalAutoDelete ?? current.operationalAutoDelete,
        piiAutoDelete: data.piiAutoDelete ?? current.piiAutoDelete,
        autoPurgeEnabled: data.autoPurgeEnabled ?? current.autoPurgeEnabled,
      },
    });
  }

  async retentionDaysFor(
    level: LogLevel,
    hasPii: boolean,
  ): Promise<number> {
    const settings = await this.getResolved();
    if (level === LogLevel.DEBUG) {
      return settings.debugAutoDelete
        ? settings.debugRetentionDays
        : settings.maxRetentionDays;
    }
    if (hasPii) {
      return settings.piiAutoDelete
        ? settings.piiRetentionDays
        : settings.maxRetentionDays;
    }
    return settings.operationalAutoDelete
      ? settings.operationalRetentionDays
      : settings.maxRetentionDays;
  }

  async getStatus(
    containsPii: (metadata: Record<string, unknown>) => boolean,
  ) {
    const settings = await this.getResolved();
    const now = new Date();
    const [total, expired] = await Promise.all([
      this.prisma.apiLog.count(),
      this.prisma.apiLog.count({
        where: { expiresAt: { lt: now } },
      }),
    ]);
    const recent = await this.prisma.apiLog.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        source: true,
        action: true,
        level: true,
        metadata: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    const samples = recent.map((log) => {
      const meta =
        log.metadata &&
        typeof log.metadata === 'object' &&
        !Array.isArray(log.metadata)
          ? (log.metadata as Record<string, unknown>)
          : {};
      let rule: LogRetentionRule = 'operational';
      if (log.level === LogLevel.DEBUG && settings.debugAutoDelete) {
        rule = 'debug';
      } else if (containsPii(meta) && settings.piiAutoDelete) {
        rule = 'pii';
      } else if (!settings.operationalAutoDelete) {
        rule = 'max_cap';
      }
      return {
        source: log.source,
        action: log.action,
        createdAt: log.createdAt,
        expiresAt: log.expiresAt,
        retentionRule: rule,
      };
    });

    return {
      settings,
      totalLogs: total,
      expiredLogs: expired,
      permanentDeletion: true,
      nextPurgeAt: this.nextPurgeAt(),
      samples,
    };
  }

  isAutoPurgeEnabled(): Promise<boolean> {
    return this.getResolved().then((s) => s.autoPurgeEnabled);
  }

  /** Next 03:00 Europe/Berlin as ISO (same clock as the purge cron). */
  private nextPurgeAt(): string {
    const timeZone = 'Europe/Berlin';
    const now = new Date();
    const dateFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const timeFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    let day = dateFmt.format(now); // YYYY-MM-DD
    if (timeFmt.format(now) >= '03:00') {
      const [y, m, d] = day.split('-').map(Number);
      day = dateFmt.format(new Date(Date.UTC(y, m - 1, d, 12) + 86_400_000));
    }
    return this.berlinLocalToIso(day, 3, 0, 0);
  }

  private berlinLocalToIso(
    ymd: string,
    hour: number,
    minute: number,
    second: number,
  ): string {
    const [y, m, d] = ymd.split('-').map(Number);
    let utcMs = Date.UTC(y, m - 1, d, hour, minute, second);
    for (let i = 0; i < 3; i += 1) {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(new Date(utcMs));
      const get = (type: string) =>
        Number(parts.find((p) => p.type === type)?.value);
      const asUtc = Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour') === 24 ? 0 : get('hour'),
        get('minute'),
        get('second'),
      );
      const target = Date.UTC(y, m - 1, d, hour, minute, second);
      utcMs += target - asUtc;
    }
    return new Date(utcMs).toISOString();
  }

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(Math.round(value), min), max);
  }
}

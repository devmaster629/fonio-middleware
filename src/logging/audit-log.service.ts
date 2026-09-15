import { Injectable } from '@nestjs/common';
import { LogLevel, Prisma } from '@prisma/client';
import { hashValue } from '../common/utils/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { LogSettingsService } from './log-settings.service';

const PII_KEY_HINTS = [
  'email',
  'phone',
  'token',
  'password',
  'guest',
  'caller',
];

@Injectable()
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logSettings: LogSettingsService,
  ) {}

  async log(params: {
    level?: LogLevel;
    source: string;
    action: string;
    method?: string;
    path?: string;
    statusCode?: number;
    durationMs?: number;
    metadata?: Record<string, unknown>;
    ip?: string;
  }) {
    const level = params.level ?? LogLevel.INFO;
    const hasPii = params.metadata
      ? this.containsPii(params.metadata)
      : false;
    const retentionDays = await this.logSettings.retentionDaysFor(
      level,
      hasPii,
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + retentionDays);

    await this.prisma.apiLog.create({
      data: {
        level,
        source: params.source,
        action: params.action,
        method: params.method,
        path: params.path,
        statusCode: params.statusCode,
        durationMs: params.durationMs,
        metadata: (params.metadata ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        ipHash: params.ip ? hashValue(params.ip) : undefined,
        expiresAt,
      },
    });
  }

  containsPii(metadata: Record<string, unknown>): boolean {
    return this.scanForPii(metadata, 0);
  }

  private scanForPii(value: unknown, depth: number): boolean {
    if (depth > 5) return false;
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) {
      return value.some((item) => this.scanForPii(item, depth + 1));
    }
    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const lower = key.toLowerCase();
        if (PII_KEY_HINTS.some((hint) => lower.includes(hint))) {
          return true;
        }
        if (this.scanForPii(nested, depth + 1)) return true;
      }
      return false;
    }
    return false;
  }

  async purgeExpired() {
    const result = await this.prisma.apiLog.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }

  retentionRuleFor(
    log: {
      level: LogLevel;
      metadata?: Prisma.JsonValue | null;
    },
    settings: {
      debugAutoDelete: boolean;
      piiAutoDelete: boolean;
      operationalAutoDelete: boolean;
    },
  ): 'debug' | 'pii' | 'operational' | 'max_cap' {
    const meta =
      log.metadata &&
      typeof log.metadata === 'object' &&
      !Array.isArray(log.metadata)
        ? (log.metadata as Record<string, unknown>)
        : {};
    if (log.level === LogLevel.DEBUG && settings.debugAutoDelete) {
      return 'debug';
    }
    if (this.containsPii(meta) && settings.piiAutoDelete) {
      return 'pii';
    }
    if (!settings.operationalAutoDelete) {
      return 'max_cap';
    }
    return 'operational';
  }

  async listForAdmin(opts: {
    page?: number;
    pageSize?: number;
    search?: string;
    source?: string;
    action?: string;
    dateFrom?: string;
    dateTo?: string;
    retention?: string;
    status?: string;
    sortBy?: string;
    sortDir?: string;
  }) {
    const page = Math.max(1, Number(opts.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(opts.pageSize) || 25));
    const search = opts.search?.trim() || '';
    const source = opts.source?.trim();
    const action = opts.action?.trim();
    const retention = opts.retention?.trim();
    const sortBy = ['createdAt', 'source', 'action', 'statusCode'].includes(
      String(opts.sortBy || ''),
    )
      ? String(opts.sortBy)
      : 'createdAt';
    const sortDir = opts.sortDir === 'asc' ? 'asc' : 'desc';

    const where: Prisma.ApiLogWhereInput = {};
    if (source && source !== 'all') where.source = source;
    if (action && action !== 'all') where.action = action;
    const status = String(opts.status || '').trim();
    if (status && status !== 'all') {
      if (status === '2xx' || status === 'ok') where.statusCode = { gte: 200, lt: 300 };
      else if (status === '4xx' || status === 'warn') where.statusCode = { gte: 400, lt: 500 };
      else if (status === '5xx' || status === 'err') where.statusCode = { gte: 500 };
      else if (/^\d{3}$/.test(status)) where.statusCode = Number(status);
    }
    if (opts.dateFrom || opts.dateTo) {
      where.createdAt = {};
      if (opts.dateFrom) {
        const from = new Date(`${opts.dateFrom}T00:00:00`);
        if (!Number.isNaN(from.getTime())) where.createdAt.gte = from;
      }
      if (opts.dateTo) {
        const to = new Date(`${opts.dateTo}T23:59:59.999`);
        if (!Number.isNaN(to.getTime())) where.createdAt.lte = to;
      }
    }
    if (search) {
      where.OR = [
        { source: { contains: search, mode: 'insensitive' } },
        { action: { contains: search, mode: 'insensitive' } },
        { path: { contains: search, mode: 'insensitive' } },
        { method: { contains: search, mode: 'insensitive' } },
      ];
    }

    const orderBy = { [sortBy]: sortDir } as Prisma.ApiLogOrderByWithRelationInput;
    const settings = await this.logSettings.getResolved();

    const [sourceRows, actionRows] = await Promise.all([
      this.prisma.apiLog.groupBy({
        by: ['source'],
        _count: { _all: true },
        orderBy: { source: 'asc' },
      }),
      this.prisma.apiLog.groupBy({
        by: ['action'],
        _count: { _all: true },
        orderBy: { action: 'asc' },
      }),
    ]);
    const facets = {
      sources: sourceRows.map((r) => r.source).filter(Boolean),
      actions: actionRows.map((r) => r.action).filter(Boolean),
    };

    const needsRetentionScan =
      !!retention && retention !== 'all';

    if (needsRetentionScan) {
      if (retention === 'debug') {
        where.level = LogLevel.DEBUG;
      } else if (retention === 'operational' || retention === 'pii') {
        where.level = { not: LogLevel.DEBUG };
      }

      const candidates = await this.prisma.apiLog.findMany({
        where,
        orderBy,
        take: 20_000,
      });
      const filtered = candidates.filter(
        (log) => this.retentionRuleFor(log, settings) === retention,
      );
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      const start = (safePage - 1) * pageSize;
      return {
        items: filtered.slice(start, start + pageSize),
        total,
        page: safePage,
        pageSize,
        totalPages,
        facets,
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.apiLog.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.apiLog.count({ where }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    if (safePage !== page) {
      const moved = await this.prisma.apiLog.findMany({
        where,
        orderBy,
        skip: (safePage - 1) * pageSize,
        take: pageSize,
      });
      return {
        items: moved,
        total,
        page: safePage,
        pageSize,
        totalPages,
        facets,
      };
    }
    return { items, total, page: safePage, pageSize, totalPages, facets };
  }
}

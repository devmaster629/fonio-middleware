import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_PORTAL_PAYMENT_RULES,
  matchPortalRule,
  parseChannelMatchers,
  type PortalPaymentRuleLike,
} from './portal-payment-rules.util';

export type PortalPaymentRuleUpdate = {
  displayName?: string;
  channelMatchers?: string[];
  enabled?: boolean;
  portalAssumedPaidPercent?: number;
  treatAsPaidUntilDaysBeforeArrival?: number | null;
  hostDuePercent?: number;
  hostDueByDaysBeforeArrival?: number | null;
  overdueGraceDays?: number | null;
  autoRequestInbox?: boolean;
  skipUnpaidReminder?: boolean;
  sortOrder?: number;
};

@Injectable()
export class PortalPaymentRulesService {
  private readonly logger = new Logger(PortalPaymentRulesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ensureDefaults(): Promise<void> {
    const count = await this.prisma.portalPaymentRule.count();
    if (count > 0) return;

    this.logger.log('Seeding default portal payment rules');
    await this.prisma.portalPaymentRule.createMany({
      data: DEFAULT_PORTAL_PAYMENT_RULES.map((rule) => ({
        portalKey: rule.portalKey,
        displayName: rule.displayName,
        channelMatchersJson: JSON.stringify(rule.channelMatchers),
        isFallback: rule.isFallback,
        enabled: rule.enabled,
        portalAssumedPaidPercent: rule.portalAssumedPaidPercent,
        treatAsPaidUntilDaysBeforeArrival:
          rule.treatAsPaidUntilDaysBeforeArrival,
        hostDuePercent: rule.hostDuePercent,
        hostDueByDaysBeforeArrival: rule.hostDueByDaysBeforeArrival,
        overdueGraceDays: rule.overdueGraceDays,
        autoRequestInbox: rule.autoRequestInbox,
        skipUnpaidReminder: rule.skipUnpaidReminder,
        sortOrder: rule.sortOrder,
      })),
    });
  }

  async list(): Promise<
    Array<
      PortalPaymentRuleLike & {
        id: string;
        channelMatchers: string[];
        sortOrder: number;
        updatedAt: Date;
      }
    >
  > {
    await this.ensureDefaults();
    const rows = await this.prisma.portalPaymentRule.findMany({
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
    });
    return rows.map((row) => ({
      ...row,
      channelMatchers: parseChannelMatchers(row.channelMatchersJson),
    }));
  }

  async findForChannel(
    channelName: string | null | undefined,
  ): Promise<PortalPaymentRuleLike | null> {
    await this.ensureDefaults();
    const rows = await this.prisma.portalPaymentRule.findMany({
      orderBy: [{ sortOrder: 'asc' }],
    });
    return matchPortalRule(channelName, rows);
  }

  async update(portalKey: string, data: PortalPaymentRuleUpdate) {
    await this.ensureDefaults();
    const existing = await this.prisma.portalPaymentRule.findUnique({
      where: { portalKey },
    });
    if (!existing) {
      throw new NotFoundException(`Unknown portal rule: ${portalKey}`);
    }

    const patch: Prisma.PortalPaymentRuleUpdateInput = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.channelMatchers !== undefined) {
      patch.channelMatchersJson = JSON.stringify(
        data.channelMatchers
          .map((m) => String(m ?? '').trim().toLowerCase())
          .filter(Boolean),
      );
    }
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.portalAssumedPaidPercent !== undefined) {
      patch.portalAssumedPaidPercent = clampPercent(
        data.portalAssumedPaidPercent,
      );
    }
    if (data.treatAsPaidUntilDaysBeforeArrival !== undefined) {
      patch.treatAsPaidUntilDaysBeforeArrival =
        data.treatAsPaidUntilDaysBeforeArrival;
    }
    if (data.hostDuePercent !== undefined) {
      patch.hostDuePercent = clampPercent(data.hostDuePercent);
    }
    if (data.hostDueByDaysBeforeArrival !== undefined) {
      patch.hostDueByDaysBeforeArrival = data.hostDueByDaysBeforeArrival;
    }
    if (data.overdueGraceDays !== undefined) {
      patch.overdueGraceDays = data.overdueGraceDays;
    }
    if (data.autoRequestInbox !== undefined) {
      patch.autoRequestInbox = data.autoRequestInbox;
    }
    if (data.skipUnpaidReminder !== undefined) {
      patch.skipUnpaidReminder = data.skipUnpaidReminder;
    }
    if (data.sortOrder !== undefined) patch.sortOrder = data.sortOrder;

    const updated = await this.prisma.portalPaymentRule.update({
      where: { portalKey },
      data: patch,
    });
    return {
      ...updated,
      channelMatchers: parseChannelMatchers(updated.channelMatchersJson),
    };
  }
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

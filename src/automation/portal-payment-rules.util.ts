export type PortalPaymentRuleLike = {
  portalKey: string;
  displayName: string;
  channelMatchersJson: string;
  isFallback: boolean;
  enabled: boolean;
  portalAssumedPaidPercent: number;
  treatAsPaidUntilDaysBeforeArrival: number | null;
  hostDuePercent: number;
  hostDueByDaysBeforeArrival: number | null;
  overdueGraceDays: number | null;
  autoRequestInbox: boolean;
  skipUnpaidReminder: boolean;
};

export type PortalBalanceEvaluation = {
  portalKey: string;
  displayName: string;
  outstanding: number;
  hostRequired: number;
  assumedPortalPaid: number;
  matchedPaid: number;
  /** Treat as paid but not yet verified on our account (e.g. Interhome before day 7). */
  paidUnverified: boolean;
  shouldOfficeRemind: boolean;
  shouldRequestInbox: boolean;
  reason: string;
};

export function parseChannelMatchers(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => String(v ?? '').trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export type PortalMatchHints = {
  hostNote?: string | null;
  guestEmail?: string | null;
};

function buildMatchHaystack(
  channelName: string | null | undefined,
  hints?: PortalMatchHints,
): string {
  return [channelName ?? '', hints?.hostNote ?? '', hints?.guestEmail ?? '']
    .join(' ')
    .toLowerCase();
}

export function matchPortalRule(
  channelName: string | null | undefined,
  rules: PortalPaymentRuleLike[],
  hints?: PortalMatchHints,
): PortalPaymentRuleLike | null {
  const haystack = buildMatchHaystack(channelName, hints);
  const enabled = rules.filter((r) => r.enabled);
  for (const rule of enabled) {
    if (rule.isFallback) continue;
    const matchers = parseChannelMatchers(rule.channelMatchersJson);
    if (matchers.some((m) => haystack.includes(m))) return rule;
  }
  return enabled.find((r) => r.isFallback) ?? null;
}

function roundMoney(n: number): number {
  return Math.max(0, Math.round(n * 100) / 100);
}

/**
 * Decide how much is still outstanding for a reservation under a portal rule.
 * `daysUntilArrival` uses the Berlin calendar day difference (arrival − today).
 */
export function evaluatePortalBalance(params: {
  totalPrice: number;
  matchedPaid: number;
  isPaid?: boolean | null;
  daysUntilArrival: number;
  rule: PortalPaymentRuleLike;
}): PortalBalanceEvaluation {
  const total = Number(params.totalPrice) || 0;
  const matchedPaid = Number(params.matchedPaid) || 0;
  const days = params.daysUntilArrival;
  const rule = params.rule;

  const base = {
    portalKey: rule.portalKey,
    displayName: rule.displayName,
    matchedPaid: roundMoney(matchedPaid),
  };

  if (params.isPaid === true) {
    return {
      ...base,
      outstanding: 0,
      hostRequired: 0,
      assumedPortalPaid: total,
      paidUnverified: false,
      shouldOfficeRemind: false,
      shouldRequestInbox: false,
      reason: 'hostaway_fully_paid',
    };
  }

  if (total <= 0) {
    return {
      ...base,
      outstanding: 0,
      hostRequired: 0,
      assumedPortalPaid: 0,
      paidUnverified: false,
      shouldOfficeRemind: false,
      shouldRequestInbox: false,
      reason: 'no_total',
    };
  }

  // Interhome / Atraveo: until N days before arrival → paid but unverified
  if (
    rule.treatAsPaidUntilDaysBeforeArrival != null &&
    days > rule.treatAsPaidUntilDaysBeforeArrival
  ) {
    return {
      ...base,
      outstanding: 0,
      hostRequired: 0,
      assumedPortalPaid: total,
      paidUnverified: true,
      shouldOfficeRemind: false,
      shouldRequestInbox: false,
      reason: 'paid_unverified',
    };
  }

  const assumedPortalPaid = roundMoney(
    (total * clampPercent(rule.portalAssumedPaidPercent)) / 100,
  );
  const hostRequired = roundMoney(
    (total * clampPercent(rule.hostDuePercent)) / 100,
  );
  const outstanding = roundMoney(hostRequired - matchedPaid);

  if (rule.skipUnpaidReminder) {
    return {
      ...base,
      outstanding: outstanding <= 1 ? 0 : outstanding,
      hostRequired,
      assumedPortalPaid,
      paidUnverified: false,
      shouldOfficeRemind: false,
      shouldRequestInbox: false,
      reason: 'portal_skip_reminder',
    };
  }

  if (outstanding <= 1) {
    return {
      ...base,
      outstanding: 0,
      hostRequired,
      assumedPortalPaid,
      paidUnverified: false,
      shouldOfficeRemind: false,
      shouldRequestInbox: false,
      reason: 'host_share_covered',
    };
  }

  const dueBy = rule.hostDueByDaysBeforeArrival;
  let shouldRequestInbox = false;
  let shouldOfficeRemind = false;
  let reason = 'outstanding';

  if (dueBy == null) {
    if (days <= 28) {
      shouldOfficeRemind = true;
      reason = 'outstanding_default_28';
    }
  } else if (days > dueBy) {
    reason = 'not_yet_due';
  } else {
    // Inside the due window (daysUntilArrival <= dueBy)
    if (rule.autoRequestInbox) {
      shouldRequestInbox = true;
    }

    if (rule.overdueGraceDays != null) {
      const overdueAt = dueBy - rule.overdueGraceDays;
      if (days <= overdueAt) {
        shouldOfficeRemind = true;
        reason = 'overdue';
      } else {
        reason = 'due_awaiting_payment';
      }
    } else if (rule.treatAsPaidUntilDaysBeforeArrival != null) {
      // Interhome: after unverified window, overdue when days <= hostDueBy (e.g. 3)
      shouldOfficeRemind = true;
      reason = 'provider_payout_missing';
    } else {
      // Direct / default: remind once we reach the due day (and catch-up if earlier days missed)
      shouldOfficeRemind = true;
      reason = 'host_share_due';
    }
  }

  return {
    ...base,
    outstanding,
    hostRequired,
    assumedPortalPaid,
    paidUnverified: false,
    shouldOfficeRemind,
    shouldRequestInbox,
    reason,
  };
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export const DEFAULT_PORTAL_PAYMENT_RULES: Array<
  Omit<PortalPaymentRuleLike, 'channelMatchersJson'> & {
    channelMatchers: string[];
    sortOrder: number;
  }
> = [
  {
    portalKey: 'airbnb',
    displayName: 'Airbnb',
    channelMatchers: ['airbnb'],
    isFallback: false,
    enabled: true,
    portalAssumedPaidPercent: 100,
    treatAsPaidUntilDaysBeforeArrival: null,
    hostDuePercent: 0,
    hostDueByDaysBeforeArrival: null,
    overdueGraceDays: null,
    autoRequestInbox: false,
    skipUnpaidReminder: true,
    sortOrder: 10,
  },
  {
    portalKey: 'bookingcom',
    displayName: 'Booking.com',
    channelMatchers: ['bookingcom', 'booking.com'],
    isFallback: false,
    enabled: true,
    portalAssumedPaidPercent: 100,
    treatAsPaidUntilDaysBeforeArrival: null,
    hostDuePercent: 0,
    hostDueByDaysBeforeArrival: null,
    overdueGraceDays: null,
    autoRequestInbox: false,
    skipUnpaidReminder: true,
    sortOrder: 20,
  },
  {
    portalKey: 'vrbo',
    displayName: 'Vrbo / HomeAway',
    channelMatchers: ['vrbo', 'homeaway'],
    isFallback: false,
    enabled: true,
    portalAssumedPaidPercent: 100,
    treatAsPaidUntilDaysBeforeArrival: null,
    hostDuePercent: 0,
    hostDueByDaysBeforeArrival: null,
    overdueGraceDays: null,
    autoRequestInbox: false,
    skipUnpaidReminder: true,
    sortOrder: 30,
  },
  {
    portalKey: 'expedia',
    displayName: 'Expedia',
    channelMatchers: ['expedia'],
    isFallback: false,
    enabled: true,
    portalAssumedPaidPercent: 100,
    treatAsPaidUntilDaysBeforeArrival: null,
    hostDuePercent: 0,
    hostDueByDaysBeforeArrival: null,
    overdueGraceDays: null,
    autoRequestInbox: false,
    skipUnpaidReminder: true,
    sortOrder: 40,
  },
  {
    portalKey: 'agoda',
    displayName: 'Agoda',
    channelMatchers: ['agoda'],
    isFallback: false,
    enabled: true,
    portalAssumedPaidPercent: 100,
    treatAsPaidUntilDaysBeforeArrival: null,
    hostDuePercent: 0,
    hostDueByDaysBeforeArrival: null,
    overdueGraceDays: null,
    autoRequestInbox: false,
    skipUnpaidReminder: true,
    sortOrder: 50,
  },
  {
    portalKey: 'hometogo',
    displayName: 'HomeToGo',
    channelMatchers: ['hometogo', 'home to go'],
    isFallback: false,
    enabled: true,
    portalAssumedPaidPercent: 100,
    treatAsPaidUntilDaysBeforeArrival: null,
    hostDuePercent: 0,
    hostDueByDaysBeforeArrival: null,
    overdueGraceDays: null,
    autoRequestInbox: false,
    skipUnpaidReminder: true,
    sortOrder: 60,
  },
  {
    portalKey: 'interhome',
    displayName: 'Interhome',
    channelMatchers: ['interhome'],
    isFallback: false,
    enabled: true,
    portalAssumedPaidPercent: 100,
    treatAsPaidUntilDaysBeforeArrival: 7,
    hostDuePercent: 100,
    hostDueByDaysBeforeArrival: 3,
    overdueGraceDays: null,
    autoRequestInbox: false,
    skipUnpaidReminder: false,
    sortOrder: 70,
  },
  {
    portalKey: 'atraveo',
    displayName: 'Atraveo',
    channelMatchers: ['atraveo'],
    isFallback: false,
    enabled: true,
    portalAssumedPaidPercent: 100,
    treatAsPaidUntilDaysBeforeArrival: 7,
    hostDuePercent: 100,
    hostDueByDaysBeforeArrival: 3,
    overdueGraceDays: null,
    autoRequestInbox: false,
    skipUnpaidReminder: false,
    sortOrder: 80,
  },
  {
    portalKey: 'travanto',
    displayName: 'Travanto',
    channelMatchers: ['travanto'],
    isFallback: false,
    enabled: true,
    portalAssumedPaidPercent: 30,
    treatAsPaidUntilDaysBeforeArrival: null,
    hostDuePercent: 70,
    hostDueByDaysBeforeArrival: 21,
    overdueGraceDays: 7,
    autoRequestInbox: true,
    skipUnpaidReminder: false,
    sortOrder: 90,
  },
  {
    portalKey: 'check24',
    displayName: 'CHECK24',
    channelMatchers: ['check24', '@check24.de', '[check24'],
    isFallback: false,
    enabled: true,
    portalAssumedPaidPercent: 0,
    treatAsPaidUntilDaysBeforeArrival: null,
    hostDuePercent: 100,
    hostDueByDaysBeforeArrival: 28,
    overdueGraceDays: null,
    autoRequestInbox: false,
    skipUnpaidReminder: false,
    sortOrder: 95,
  },
  {
    portalKey: 'direct',
    displayName: 'Direct / other',
    channelMatchers: [],
    isFallback: true,
    enabled: true,
    portalAssumedPaidPercent: 0,
    treatAsPaidUntilDaysBeforeArrival: null,
    hostDuePercent: 100,
    hostDueByDaysBeforeArrival: 28,
    overdueGraceDays: null,
    autoRequestInbox: false,
    skipUnpaidReminder: false,
    sortOrder: 100,
  },
];

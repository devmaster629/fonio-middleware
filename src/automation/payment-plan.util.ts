import { PaymentPlanFrequency } from '@prisma/client';

export type PaymentPlanLike = {
  enabled: boolean;
  installmentAmount: number;
  frequency: PaymentPlanFrequency;
  customIntervalDays: number | null;
  nextDueAmount: number;
  nextDueAt: Date | null;
  paidTowardPlan: number;
};

/** Round money to cents. */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function amountsClose(a: number, b: number): boolean {
  const tolerance = Math.max(1, Math.abs(b) * 0.005);
  return Math.abs(a - b) <= tolerance;
}

/** Advance a due date by one plan period. */
export function advanceDueDate(
  from: Date,
  frequency: PaymentPlanFrequency,
  customIntervalDays?: number | null,
): Date {
  const next = new Date(from);
  next.setUTCHours(0, 0, 0, 0);
  switch (frequency) {
    case PaymentPlanFrequency.WEEKLY:
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case PaymentPlanFrequency.SEMI_MONTHLY:
      next.setUTCDate(next.getUTCDate() + 14);
      break;
    case PaymentPlanFrequency.MONTHLY: {
      const day = next.getUTCDate();
      next.setUTCMonth(next.getUTCMonth() + 1);
      // Clamp end-of-month (e.g. Jan 31 → Feb 28)
      if (next.getUTCDate() < day) {
        next.setUTCDate(0);
      }
      break;
    }
    case PaymentPlanFrequency.CUSTOM: {
      const days =
        customIntervalDays != null && customIntervalDays > 0
          ? customIntervalDays
          : 30;
      next.setUTCDate(next.getUTCDate() + days);
      break;
    }
    default:
      next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
}

/** Rewind a due date by one plan period (best-effort undo). */
export function rewindDueDate(
  from: Date,
  frequency: PaymentPlanFrequency,
  customIntervalDays?: number | null,
): Date {
  const prev = new Date(from);
  prev.setUTCHours(0, 0, 0, 0);
  switch (frequency) {
    case PaymentPlanFrequency.WEEKLY:
      prev.setUTCDate(prev.getUTCDate() - 7);
      break;
    case PaymentPlanFrequency.SEMI_MONTHLY:
      prev.setUTCDate(prev.getUTCDate() - 14);
      break;
    case PaymentPlanFrequency.MONTHLY: {
      const day = prev.getUTCDate();
      prev.setUTCMonth(prev.getUTCMonth() - 1);
      if (prev.getUTCDate() < day) {
        prev.setUTCDate(0);
      }
      break;
    }
    case PaymentPlanFrequency.CUSTOM: {
      const days =
        customIntervalDays != null && customIntervalDays > 0
          ? customIntervalDays
          : 30;
      prev.setUTCDate(prev.getUTCDate() - days);
      break;
    }
    default:
      prev.setUTCMonth(prev.getUTCMonth() - 1);
  }
  return prev;
}

/**
 * After recording a payment toward the plan, compute the next ledger state.
 * Matching the current nextDueAmount advances the schedule; underpayments
 * reduce the remaining installment due.
 */
export function applyPaymentToPlan(
  plan: PaymentPlanLike,
  amount: number,
  options: { remainingBalance?: number | null; today?: Date } = {},
): {
  paidTowardPlan: number;
  nextDueAmount: number;
  nextDueAt: Date | null;
  advanced: boolean;
} {
  const paidTowardPlan = roundMoney(plan.paidTowardPlan + amount);
  const today = options.today ?? new Date();
  today.setUTCHours(0, 0, 0, 0);

  let nextDueAmount = plan.nextDueAmount;
  let nextDueAt = plan.nextDueAt;
  let advanced = false;

  const coversInstallment =
    amountsClose(amount, plan.nextDueAmount) ||
    amount + 0.5 >= plan.nextDueAmount;

  if (coversInstallment) {
    advanced = true;
    const base = plan.nextDueAt ?? today;
    nextDueAt = advanceDueDate(base, plan.frequency, plan.customIntervalDays);
    nextDueAmount = plan.installmentAmount;
  } else if (amount > 0 && amount < plan.nextDueAmount) {
    nextDueAmount = roundMoney(Math.max(0, plan.nextDueAmount - amount));
  }

  const remaining =
    options.remainingBalance != null && Number.isFinite(options.remainingBalance)
      ? Math.max(0, options.remainingBalance)
      : null;
  if (remaining != null && remaining <= 0.5) {
    nextDueAmount = 0;
  } else if (remaining != null) {
    nextDueAmount = roundMoney(Math.min(nextDueAmount, remaining));
  }

  return { paidTowardPlan, nextDueAmount, nextDueAt, advanced };
}

/** Reverse a previously applied payment against the plan (undo). */
export function reversePaymentOnPlan(
  plan: PaymentPlanLike,
  amount: number,
  options: { remainingBalance?: number | null } = {},
): {
  paidTowardPlan: number;
  nextDueAmount: number;
  nextDueAt: Date | null;
} {
  const paidTowardPlan = roundMoney(Math.max(0, plan.paidTowardPlan - amount));

  let nextDueAmount = plan.nextDueAmount;
  let nextDueAt = plan.nextDueAt;

  // If the reversed amount looks like a full installment, rewind one period
  // and restore nextDue to the installment (or the reversed amount).
  if (
    amountsClose(amount, plan.installmentAmount) ||
    amountsClose(amount, plan.nextDueAmount) ||
    amount + 0.5 >= plan.installmentAmount
  ) {
    if (plan.nextDueAt) {
      nextDueAt = rewindDueDate(
        plan.nextDueAt,
        plan.frequency,
        plan.customIntervalDays,
      );
    }
    nextDueAmount = plan.installmentAmount;
  } else if (amount > 0) {
    nextDueAmount = roundMoney(plan.nextDueAmount + amount);
  }

  const remaining =
    options.remainingBalance != null && Number.isFinite(options.remainingBalance)
      ? Math.max(0, options.remainingBalance)
      : null;
  if (remaining != null && remaining > 0) {
    nextDueAmount = roundMoney(Math.min(Math.max(nextDueAmount, amount), remaining));
  }

  return { paidTowardPlan, nextDueAmount, nextDueAt };
}

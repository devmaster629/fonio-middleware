import type { PortalPaymentRuleLike } from './portal-payment-rules.util';

export type PaymentPhase = 'deposit' | 'balance' | 'full' | 'none';

export type GuestPaymentSchedule = {
  phase: PaymentPhase;
  amountDue: number;
  shouldRequestPayment: boolean;
  shouldSendGuestReminder: boolean;
  shouldCancel: boolean;
  reason: string;
};

export type GuestPaymentReservationState = {
  guestPaymentRequestSentAt?: Date | null;
  guestPaymentReminderSentAt?: Date | null;
  paymentDeadlineAt?: Date | null;
  paymentPhase?: string | null;
  bookedAt?: Date | null;
};

function roundMoney(n: number): number {
  return Math.max(0, Math.round(n * 100) / 100);
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function berlinDaysSince(date: Date | null | undefined, now = new Date()): number {
  if (!date) return 0;
  const bookedYmd = date.toISOString().slice(0, 10);
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const booked = Date.parse(`${bookedYmd}T00:00:00.000Z`);
  const today = Date.parse(`${todayYmd}T00:00:00.000Z`);
  return Math.max(0, Math.round((today - booked) / 86_400_000));
}

export function depositAmount(total: number, rule: PortalPaymentRuleLike): number {
  const pct = rule.depositDuePercent ?? 0;
  if (pct <= 0) return 0;
  return roundMoney((total * clampPercent(pct)) / 100);
}

export function balanceAmount(total: number, rule: PortalPaymentRuleLike): number {
  const dep = depositAmount(total, rule);
  if (dep > 0) return roundMoney(total - dep);
  return roundMoney((total * clampPercent(rule.hostDuePercent)) / 100);
}

export function fullAmount(total: number, rule: PortalPaymentRuleLike): number {
  return roundMoney((total * clampPercent(rule.hostDuePercent)) / 100);
}

export function paidTowardPhase(
  matchedPaid: number,
  phase: PaymentPhase,
  total: number,
  rule: PortalPaymentRuleLike,
): number {
  if (phase === 'deposit') return Math.min(matchedPaid, depositAmount(total, rule));
  if (phase === 'balance') {
    const dep = depositAmount(total, rule);
    return Math.max(0, matchedPaid - dep);
  }
  return matchedPaid;
}

export function evaluateGuestPaymentSchedule(params: {
  rule: PortalPaymentRuleLike;
  totalPrice: number;
  matchedPaid: number;
  isPaid?: boolean | null;
  daysUntilArrival: number;
  daysSinceBooking: number;
  now?: Date;
  reservation: GuestPaymentReservationState;
}): GuestPaymentSchedule {
  const now = params.now ?? new Date();
  const rule = params.rule;
  const total = Number(params.totalPrice) || 0;
  const matchedPaid = Number(params.matchedPaid) || 0;
  const none = (reason: string): GuestPaymentSchedule => ({
    phase: 'none',
    amountDue: 0,
    shouldRequestPayment: false,
    shouldSendGuestReminder: false,
    shouldCancel: false,
    reason,
  });

  if (params.isPaid === true || total <= 0) return none('paid_or_no_total');

  const hasDeposit =
    rule.depositDuePercent != null &&
    rule.depositDuePercent > 0 &&
    rule.depositDueDaysAfterBooking != null;

  if (params.reservation.guestPaymentRequestSentAt && params.reservation.paymentDeadlineAt) {
    const deadline = params.reservation.paymentDeadlineAt;
    const phase = (params.reservation.paymentPhase as PaymentPhase) || 'full';
    const amountDue =
      phase === 'deposit'
        ? depositAmount(total, rule)
        : phase === 'balance'
          ? balanceAmount(total, rule)
          : fullAmount(total, rule);
    const paid = paidTowardPhase(matchedPaid, phase, total, rule);
    const outstanding = roundMoney(amountDue - paid);

    if (outstanding <= 1) return none('phase_covered');

    const reminderDays = rule.guestReminderDaysBeforeDeadline ?? 0;
    const reminderAt = new Date(deadline.getTime() - reminderDays * 86_400_000);

    if (now >= deadline && rule.autoCancelIfUnpaid) {
      return {
        phase,
        amountDue: outstanding,
        shouldRequestPayment: false,
        shouldSendGuestReminder: false,
        shouldCancel: true,
        reason: 'deadline_passed',
      };
    }

    if (
      reminderDays > 0 &&
      now >= reminderAt &&
      now < deadline &&
      !params.reservation.guestPaymentReminderSentAt
    ) {
      return {
        phase,
        amountDue: outstanding,
        shouldRequestPayment: false,
        shouldSendGuestReminder: true,
        shouldCancel: false,
        reason: 'guest_reminder_before_deadline',
      };
    }

    return {
      phase,
      amountDue: outstanding,
      shouldRequestPayment: false,
      shouldSendGuestReminder: false,
      shouldCancel: false,
      reason: 'awaiting_payment',
    };
  }

  if (hasDeposit) {
    const dep = depositAmount(total, rule);
    const depPaid = paidTowardPhase(matchedPaid, 'deposit', total, rule);
    const depOutstanding = roundMoney(dep - depPaid);
    const depositWindow = rule.depositDueDaysAfterBooking ?? 7;

    if (
      depOutstanding > 1 &&
      params.daysSinceBooking <= depositWindow &&
      !params.reservation.guestPaymentRequestSentAt
    ) {
      return {
        phase: 'deposit',
        amountDue: depOutstanding,
        shouldRequestPayment: rule.autoSendGuestPaymentLink,
        shouldSendGuestReminder: false,
        shouldCancel: false,
        reason: 'deposit_due',
      };
    }

    const balance = balanceAmount(total, rule);
    const balPaid = paidTowardPhase(matchedPaid, 'balance', total, rule);
    const balOutstanding = roundMoney(balance - balPaid);
    const dueBy = rule.hostDueByDaysBeforeArrival;

    if (
      balOutstanding > 1 &&
      dueBy != null &&
      params.daysUntilArrival <= dueBy &&
      matchedPaid + 0.5 >= dep &&
      !params.reservation.guestPaymentRequestSentAt &&
      (params.reservation.paymentPhase == null ||
        params.reservation.paymentPhase === 'deposit' ||
        params.reservation.paymentPhase === 'deposit_paid')
    ) {
      return {
        phase: 'balance',
        amountDue: balOutstanding,
        shouldRequestPayment: rule.autoSendGuestPaymentLink,
        shouldSendGuestReminder: false,
        shouldCancel: false,
        reason: 'balance_due',
      };
    }

    return none('direct_no_action');
  }

  const outstanding = roundMoney(fullAmount(total, rule) - matchedPaid);
  if (outstanding <= 1) return none('fully_covered');

  return none('no_schedule');
}

import { DEFAULT_PORTAL_PAYMENT_RULES } from './portal-payment-rules.util';
import {
  depositAmount,
  evaluateGuestPaymentSchedule,
} from './guest-payment-schedule.util';

describe('guest-payment-schedule.util', () => {
  const check24 = DEFAULT_PORTAL_PAYMENT_RULES.find((r) => r.portalKey === 'check24')!;
  const direct = DEFAULT_PORTAL_PAYMENT_RULES.find((r) => r.portalKey === 'direct')!;

  it('schedules CHECK24 guest reminder before deadline', () => {
    const deadline = new Date('2026-08-10T12:00:00Z');
    const now = new Date('2026-08-08T12:00:00Z');
    const ev = evaluateGuestPaymentSchedule({
      rule: check24,
      totalPrice: 1000,
      matchedPaid: 0,
      daysUntilArrival: 40,
      daysSinceBooking: 2,
      now,
      reservation: {
        guestPaymentRequestSentAt: new Date('2026-08-01'),
        paymentDeadlineAt: deadline,
        paymentPhase: 'full',
      },
    });
    expect(ev.shouldSendGuestReminder).toBe(true);
    expect(ev.shouldCancel).toBe(false);
  });

  it('cancels CHECK24 after deadline when still unpaid', () => {
    const deadline = new Date('2026-08-01T12:00:00Z');
    const now = new Date('2026-08-02T12:00:00Z');
    const ev = evaluateGuestPaymentSchedule({
      rule: check24,
      totalPrice: 1000,
      matchedPaid: 0,
      daysUntilArrival: 40,
      daysSinceBooking: 9,
      now,
      reservation: {
        guestPaymentRequestSentAt: new Date('2026-07-25'),
        paymentDeadlineAt: deadline,
        paymentPhase: 'full',
      },
    });
    expect(ev.shouldCancel).toBe(true);
  });

  it('requests direct deposit within booking window', () => {
    const ev = evaluateGuestPaymentSchedule({
      rule: direct,
      totalPrice: 1000,
      matchedPaid: 0,
      daysUntilArrival: 60,
      daysSinceBooking: 1,
      reservation: {},
    });
    expect(ev.phase).toBe('deposit');
    expect(ev.shouldRequestPayment).toBe(true);
    expect(depositAmount(1000, direct)).toBe(300);
  });

  it('requests direct balance 28 days before arrival after deposit paid', () => {
    const ev = evaluateGuestPaymentSchedule({
      rule: direct,
      totalPrice: 1000,
      matchedPaid: 300,
      daysUntilArrival: 28,
      daysSinceBooking: 20,
      reservation: { paymentPhase: 'deposit_paid' },
    });
    expect(ev.phase).toBe('balance');
    expect(ev.amountDue).toBe(700);
    expect(ev.shouldRequestPayment).toBe(true);
  });
});

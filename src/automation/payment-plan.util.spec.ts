import { PaymentPlanFrequency } from '@prisma/client';
import {
  advanceDueDate,
  amountsClose,
  applyPaymentToPlan,
  reversePaymentOnPlan,
  rewindDueDate,
} from './payment-plan.util';

describe('payment-plan.util', () => {
  const basePlan = {
    enabled: true,
    installmentAmount: 550,
    frequency: PaymentPlanFrequency.MONTHLY,
    customIntervalDays: null as number | null,
    nextDueAmount: 550,
    nextDueAt: new Date('2026-09-01T00:00:00.000Z'),
    paidTowardPlan: 1100,
  };

  it('advances monthly due date and paidTowardPlan when installment matches', () => {
    const next = applyPaymentToPlan(basePlan, 550, {
      remainingBalance: 3740,
      today: new Date('2026-09-01'),
    });
    expect(next.advanced).toBe(true);
    expect(next.paidTowardPlan).toBe(1650);
    expect(next.nextDueAmount).toBe(550);
    expect(next.nextDueAt?.toISOString().slice(0, 10)).toBe('2026-10-01');
  });

  it('reduces nextDueAmount on underpayment without advancing date', () => {
    const next = applyPaymentToPlan(basePlan, 200, {
      remainingBalance: 4090,
    });
    expect(next.advanced).toBe(false);
    expect(next.paidTowardPlan).toBe(1300);
    expect(next.nextDueAmount).toBe(350);
    expect(next.nextDueAt?.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('clamps next due to remaining balance after final installment', () => {
    const next = applyPaymentToPlan(
      { ...basePlan, nextDueAmount: 550 },
      550,
      { remainingBalance: 400 },
    );
    expect(next.nextDueAmount).toBe(400);
  });

  it('zeros next due when booking is fully paid', () => {
    const next = applyPaymentToPlan(basePlan, 550, { remainingBalance: 0 });
    expect(next.nextDueAmount).toBe(0);
  });

  it('rewinds plan on reverse of a full installment', () => {
    const after = reversePaymentOnPlan(
      {
        ...basePlan,
        paidTowardPlan: 1650,
        nextDueAt: new Date('2026-10-01T00:00:00.000Z'),
      },
      550,
      { remainingBalance: 4290 },
    );
    expect(after.paidTowardPlan).toBe(1100);
    expect(after.nextDueAmount).toBe(550);
    expect(after.nextDueAt?.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('amountsClose tolerates small FX noise', () => {
    expect(amountsClose(550, 550.01)).toBe(true);
    expect(amountsClose(550, 560)).toBe(false);
  });

  it('advanceDueDate supports semi-monthly and custom intervals', () => {
    const from = new Date('2026-09-01T00:00:00.000Z');
    expect(
      advanceDueDate(from, PaymentPlanFrequency.SEMI_MONTHLY)
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-09-15');
    expect(
      advanceDueDate(from, PaymentPlanFrequency.CUSTOM, 10)
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-09-11');
    expect(
      rewindDueDate(new Date('2026-09-15T00:00:00.000Z'), PaymentPlanFrequency.SEMI_MONTHLY)
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-09-01');
  });
});

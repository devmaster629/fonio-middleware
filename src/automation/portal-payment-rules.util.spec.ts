import {
  DEFAULT_PORTAL_PAYMENT_RULES,
  evaluatePortalBalance,
  matchPortalRule,
  parseChannelMatchers,
} from './portal-payment-rules.util';

describe('portal-payment-rules.util', () => {
  const rules = DEFAULT_PORTAL_PAYMENT_RULES.map((r) => ({
    ...r,
    channelMatchersJson: JSON.stringify(r.channelMatchers),
  }));

  it('matches HomeToGo and skips reminders', () => {
    const rule = matchPortalRule('HomeToGo', rules)!;
    expect(rule.portalKey).toBe('hometogo');
    const ev = evaluatePortalBalance({
      totalPrice: 500,
      matchedPaid: 0,
      daysUntilArrival: 28,
      rule,
    });
    expect(ev.shouldOfficeRemind).toBe(false);
    expect(ev.reason).toBe('portal_skip_reminder');
  });

  it('treats Interhome as paid unverified until 7 days before arrival', () => {
    const rule = matchPortalRule('Interhome', rules)!;
    const early = evaluatePortalBalance({
      totalPrice: 400,
      matchedPaid: 0,
      daysUntilArrival: 20,
      rule,
    });
    expect(early.paidUnverified).toBe(true);
    expect(early.shouldOfficeRemind).toBe(false);

    const overdue = evaluatePortalBalance({
      totalPrice: 400,
      matchedPaid: 0,
      daysUntilArrival: 3,
      rule,
    });
    expect(overdue.shouldOfficeRemind).toBe(true);
    expect(overdue.outstanding).toBe(400);
    expect(overdue.reason).toBe('provider_payout_missing');
  });

  it('requests Travanto 70% at 21 days and marks overdue after 7 days', () => {
    const rule = matchPortalRule('travanto', rules)!;
    const at21 = evaluatePortalBalance({
      totalPrice: 1000,
      matchedPaid: 0,
      daysUntilArrival: 21,
      rule,
    });
    expect(at21.outstanding).toBe(700);
    expect(at21.shouldRequestInbox).toBe(true);
    expect(at21.shouldOfficeRemind).toBe(false);

    const at14 = evaluatePortalBalance({
      totalPrice: 1000,
      matchedPaid: 0,
      daysUntilArrival: 14,
      rule,
    });
    expect(at14.shouldOfficeRemind).toBe(true);
    expect(at14.reason).toBe('overdue');
  });

  it('respects Hostaway Fully Paid', () => {
    const rule = matchPortalRule('direct booking', rules)!;
    const ev = evaluatePortalBalance({
      totalPrice: 300,
      matchedPaid: 0,
      isPaid: true,
      daysUntilArrival: 28,
      rule,
    });
    expect(ev.shouldOfficeRemind).toBe(false);
    expect(ev.reason).toBe('hostaway_fully_paid');
  });

  it('parses channel matchers', () => {
    expect(parseChannelMatchers('["Booking.com"," Travanto "]')).toEqual([
      'booking.com',
      'travanto',
    ]);
  });
});

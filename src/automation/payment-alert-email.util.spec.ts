import { ExternalPaymentSource } from '@prisma/client';
import type { PaymentMatchCandidate } from './automation.types';
import {
  buildKiSignals,
  buildNeedsReviewEmail,
  formatAmountDe,
  formatReceivedAtDe,
  paymentSourceLabelDe,
  prettyChannelDe,
  scorePercent,
} from './payment-alert-email.util';

function candidate(
  overrides: Partial<PaymentMatchCandidate> & Pick<PaymentMatchCandidate, 'hostawayId'>,
): PaymentMatchCandidate {
  return {
    reservationId: `res-${overrides.hostawayId}`,
    guestName: 'Tobias Altmann',
    listingName: 'Apartment Test',
    arrivalDate: '2026-08-01',
    departureDate: '2026-08-05',
    channelName: 'bookingcom',
    hostNote: null,
    totalPrice: 900,
    balanceDue: 900,
    score: 94,
    reasons: ['Guest name matches', 'Stay dates appear in reference'],
    ...overrides,
  };
}

describe('payment-alert-email.util', () => {
  it('formats German amount and Qonto source label', () => {
    expect(formatAmountDe(894.13, 'EUR')).toMatch(/894,13/);
    expect(paymentSourceLabelDe(ExternalPaymentSource.QONTO)).toBe(
      'Qonto – Banküberweisung',
    );
    expect(prettyChannelDe('bookingcom')).toBe('Booking.com');
  });

  it('formats received time in Europe/Berlin', () => {
    const label = formatReceivedAtDe(new Date('2026-07-24T07:30:00.000Z'));
    expect(label).toMatch(/24\.07\.2026/);
    expect(label).toMatch(/Uhr/);
  });

  it('builds a structured German needs-review email with KI summary', () => {
    const email = buildNeedsReviewEmail({
      amount: 894.13,
      currency: 'EUR',
      source: ExternalPaymentSource.QONTO,
      payerName: 'Tobias Altmann',
      occurredAt: new Date('2026-07-24T07:30:00.000Z'),
      matchReason: 'Several bookings look similarly likely.',
      candidates: [
        candidate({ hostawayId: 62966259, score: 94 }),
        candidate({
          hostawayId: 63168493,
          score: 91,
          guestName: 'Tobias A.',
        }),
      ],
      dashboardUrl: 'https://example.com/admin?tab=payments',
      correlationId: 'pay-review-test',
    });

    expect(email.subject).toContain('Zahlung erhalten');
    expect(email.subject).toContain('Manuelle Zuordnung erforderlich');
    expect(email.subject).toContain('Tobias Altmann');
    expect(email.subject).toMatch(/894,13/);

    expect(email.text).toContain('Betrag:');
    expect(email.text).toContain('Gast:');
    expect(email.text).toContain('Zahlungsquelle:');
    expect(email.text).toContain('Buchungsquelle:');
    expect(email.text).toContain('Booking.com');
    expect(email.text).toContain('#62966259 / #63168493');
    expect(email.text).toContain('KI-Analyse');
    expect(email.text).toContain('Vorschlag 1: 94 % Übereinstimmung');
    expect(email.text).toContain('Vorschlag 2: 91 % Übereinstimmung');
    expect(email.text).toContain('Gastname gefunden ✓');
    expect(email.text).toContain('Reisezeitraum gefunden ✓');
    expect(email.text).toContain('Zahlung jetzt zuordnen');
    expect(email.text).toContain('https://example.com/admin?tab=payments');

    expect(email.html).toContain('Zahlung jetzt zuordnen');
    expect(email.html).toContain('KI-Analyse');
    expect(email.html).toContain('#62966259 / #63168493');
  });

  it('maps matcher reasons to German KI signals', () => {
    expect(
      buildKiSignals(
        candidate({
          hostawayId: 1,
          reasons: ['Guest name matches', 'Stay dates appear in reference'],
        }),
      ),
    ).toEqual(['Gastname gefunden ✓', 'Reisezeitraum gefunden ✓']);
    expect(scorePercent(94.4)).toBe(94);
    expect(scorePercent(120)).toBe(100);
  });
});

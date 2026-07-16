import { PaymentMatcherService } from './payment-matcher.service';
import { NormalizedExternalPayment } from './automation.types';

describe('PaymentMatcherService', () => {
  const prisma = {
    reservation: {
      findMany: jest.fn(),
    },
  };
  const service = new PaymentMatcherService(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  it('auto-matches when reservation number is in reference', async () => {
    prisma.reservation.findMany.mockResolvedValue([
      {
        id: 'res-1',
        hostawayId: 62144308,
        guestName: 'Max Mustermann',
        guestEmail: 'max@example.com',
        arrivalDate: new Date('2026-08-08'),
        departureDate: new Date('2026-08-10'),
        listing: { name: 'Wiesenblick', aliases: [] },
        totalPrice: 250,
        notifiedCharges: [],
      },
      {
        id: 'res-2',
        hostawayId: 62571674,
        guestName: 'Anna Schmidt',
        guestEmail: 'anna@example.com',
        arrivalDate: new Date('2026-09-01'),
        departureDate: new Date('2026-09-05'),
        listing: { name: 'Bergdomizil', aliases: [] },
        totalPrice: 500,
        notifiedCharges: [],
      },
    ]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-1',
      amount: 250,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'Max Mustermann',
      reference: 'Reservierung 62144308 Wiesenblick 250.00',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(result.decision).toBe('UNAMBIGUOUS');
    expect(result.best?.hostawayId).toBe(62144308);
    expect(result.best?.totalPrice).toBe(250);
    expect(result.best?.arrivalDate).toBe('2026-08-08');
  });

  it('sends ambiguous payments to review', async () => {
    prisma.reservation.findMany.mockResolvedValue([
      {
        id: 'res-1',
        hostawayId: 62144308,
        guestName: 'Max Mustermann',
        guestEmail: 'max@example.com',
        arrivalDate: new Date('2026-08-08'),
        departureDate: new Date('2026-08-10'),
        listing: { name: 'Wiesenblick', aliases: [] },
        totalPrice: 250,
        notifiedCharges: [],
      },
      {
        id: 'res-2',
        hostawayId: 62144309,
        guestName: 'Max Mustermann',
        guestEmail: 'max2@example.com',
        arrivalDate: new Date('2026-08-12'),
        departureDate: new Date('2026-08-14'),
        listing: { name: 'Wiesenblick 2', aliases: [] },
        totalPrice: 250,
        notifiedCharges: [],
      },
    ]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-2',
      amount: 250,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'Max Mustermann',
      reference: 'Überweisung Max Mustermann',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(['AMBIGUOUS', 'PARTIAL_UNCLEAR']).toContain(result.decision);
    expect((result.candidates?.length ?? 0)).toBeGreaterThan(1);
  });

  it('boosts score when amount equals outstanding balance', async () => {
    prisma.reservation.findMany.mockResolvedValue([
      {
        id: 'res-1',
        hostawayId: 62144308,
        guestName: 'Max Mustermann',
        guestEmail: 'max@example.com',
        arrivalDate: new Date('2026-08-08'),
        departureDate: new Date('2026-08-10'),
        totalPrice: 1000,
        notifiedCharges: [{ amount: 300 }],
        listing: { name: 'Wiesenblick', aliases: [] },
      },
      {
        id: 'res-2',
        hostawayId: 62571674,
        guestName: 'Max Mustermann',
        guestEmail: 'other@example.com',
        arrivalDate: new Date('2026-09-01'),
        departureDate: new Date('2026-09-05'),
        totalPrice: 2500,
        notifiedCharges: [],
        listing: { name: 'Bergdomizil', aliases: [] },
      },
    ]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-3',
      amount: 700,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'Max Mustermann',
      reference: 'Restzahlung',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(result.best?.hostawayId).toBe(62144308);
    expect(result.best?.reasons.join(' ')).toContain('outstanding balance');
  });

  it('auto-skips Airbnb platform payouts', async () => {
    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-4',
      amount: 613.05,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'AIRBNB PAYMENTS LUXEMBOURG S.A.',
      reference: 'Airbnb | income',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(result.decision).toBe('PLATFORM_PAYOUT');
    expect(prisma.reservation.findMany).not.toHaveBeenCalled();
  });
});

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
    expect(result.reason).not.toMatch(/score|threshold/i);
    expect(result.reason.length).toBeGreaterThan(20);
  });

  it('explains partial matches in plain language without scores', async () => {
    prisma.reservation.findMany.mockResolvedValue([
      {
        id: 'res-1',
        hostawayId: 35902633,
        guestName: 'Peter Walther',
        guestEmail: 'peter@example.com',
        arrivalDate: new Date('2026-07-01'),
        departureDate: new Date('2026-07-31'),
        totalPrice: 5390,
        notifiedCharges: [],
        listing: { name: '43 Sand-Style', aliases: [] },
      },
    ]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-partial',
      amount: 550,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'PETER WALTHER',
      reference: 'PETER WALTHER Juli teil 2',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(result.decision).toBe('PARTIAL_UNCLEAR');
    expect(result.reason).toMatch(/Matched on:/i);
    expect(result.reason).toMatch(/payment amount/i);
    expect(result.reason).not.toMatch(/score|threshold/i);
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

  it('matches deposits documented in host notes (amount + Restbetrag)', async () => {
    prisma.reservation.findMany.mockResolvedValue([
      {
        id: 'res-braun',
        hostawayId: 60347269,
        guestName: 'Robert Braun',
        guestEmail: null,
        arrivalDate: new Date('2026-07-27'),
        departureDate: new Date('2026-07-31'),
        totalPrice: 1461.5,
        channelName: 'direct',
        hostNote:
          'MIT HANDTÜCHERN\n70% (960,05 €) Restbetrag vor Anreise (13.07.2026) direkt an uns per Banküberweisung zu zahlen',
        guestNote: null,
        comment: null,
        notifiedCharges: [],
        listing: {
          name: '3,5 Zimmer-Wohnung Waldblick barrierefrei',
          aliases: [],
        },
      },
    ]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-deposit',
      amount: 960.05,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'ROBERT UND ELISABETH BRAUN',
      reference: 'Robert Braun Buchungsnummer 5721249',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(result.best?.hostawayId).toBe(60347269);
    expect(result.best?.reasons.join(' ')).toMatch(/notes/i);
    expect(result.best?.reasons.join(' ')).toMatch(/deposit|installment/i);
    expect(result.decision).toBe('UNAMBIGUOUS');
  });

  it('does not auto-match name-only weak evidence', async () => {
    prisma.reservation.findMany.mockResolvedValue([
      {
        id: 'res-1',
        hostawayId: 60347269,
        guestName: 'Robert Braun',
        guestEmail: null,
        arrivalDate: new Date('2026-07-27'),
        departureDate: new Date('2026-07-31'),
        totalPrice: 1461.5,
        hostNote: null,
        guestNote: null,
        comment: null,
        notifiedCharges: [],
        listing: { name: 'Waldblick', aliases: [] },
      },
    ]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-name-only',
      // Tiny amount — not a plausible deposit share of 1461.50
      amount: 55,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'ROBERT UND ELISABETH BRAUN',
      reference: 'Robert Braun Buchungsnummer 5721249',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(result.decision).toBe('PARTIAL_UNCLEAR');
    expect(result.reason).toMatch(/Not enough for automatic/i);
  });

  it('keeps ambiguous multi-booking name matches in review', async () => {
    prisma.reservation.findMany.mockResolvedValue([
      {
        id: 'res-a',
        hostawayId: 62966259,
        guestName: 'Tobias Altmann',
        guestEmail: null,
        arrivalDate: new Date('2027-04-20'),
        departureDate: new Date('2027-04-23'),
        totalPrice: 2583,
        hostNote: null,
        guestNote: null,
        comment: null,
        notifiedCharges: [],
        listing: { name: 'Apartment A', aliases: [] },
      },
      {
        id: 'res-b',
        hostawayId: 62966260,
        guestName: 'Tobias Altmann',
        guestEmail: null,
        arrivalDate: new Date('2027-05-01'),
        departureDate: new Date('2027-05-05'),
        totalPrice: 2100,
        hostNote: null,
        guestNote: null,
        comment: null,
        notifiedCharges: [],
        listing: { name: 'Apartment B', aliases: [] },
      },
    ]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-altmann',
      amount: 894.13,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'Tobias Altmann',
      reference: 'Tobias Altmann Anzahlung',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(result.decision).toBe('AMBIGUOUS');
    expect(result.decision).not.toBe('UNAMBIGUOUS');
    expect((result.candidates?.length ?? 0)).toBeGreaterThan(1);
  });

  it('does not auto-apply unique guest match without clear amount evidence', async () => {
    prisma.reservation.findMany.mockResolvedValue([
      {
        id: 'res-a',
        hostawayId: 62966259,
        guestName: 'Tobias Altmann',
        guestEmail: null,
        arrivalDate: new Date('2027-04-20'),
        departureDate: new Date('2027-04-23'),
        totalPrice: 2583,
        hostNote: null,
        guestNote: null,
        comment: null,
        notifiedCharges: [],
        listing: { name: 'Apartment A', aliases: [] },
      },
    ]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-altmann-partial',
      // Far from a deposit share of 2583 (~3%)
      amount: 80,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'Tobias Altmann',
      reference: 'Betreff bitte T.Altmann 23.04.2027',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(result.decision).toBe('PARTIAL_UNCLEAR');
  });

  it('excludes Booking.com / Airbnb amount coincidences from suggestions', async () => {
    prisma.reservation.findMany.mockResolvedValue([
      {
        id: 'res-maveo',
        hostawayId: 64501796,
        guestName: 'MAVEO GmbH',
        guestEmail: null,
        arrivalDate: new Date('2026-12-17'),
        departureDate: new Date('2026-12-20'),
        totalPrice: 1500,
        channelName: 'direct',
        hostNote: null,
        guestNote: null,
        comment: null,
        notifiedCharges: [],
        listing: { name: 'Wiesenblick', aliases: [] },
      },
      {
        id: 'res-bcom',
        hostawayId: 65287790,
        guestName: 'Wim Verheyen',
        guestEmail: null,
        arrivalDate: new Date('2026-08-28'),
        departureDate: new Date('2026-08-31'),
        totalPrice: 473.85,
        channelName: 'bookingcom',
        hostNote: null,
        guestNote: null,
        comment: null,
        notifiedCharges: [],
        listing: { name: 'Other', aliases: [] },
      },
      {
        id: 'res-airbnb',
        hostawayId: 63595295,
        guestName: 'Britta Ifsen',
        guestEmail: null,
        arrivalDate: new Date('2026-07-28'),
        departureDate: new Date('2026-07-31'),
        totalPrice: 477.38,
        channelName: 'airbnbOfficial',
        hostNote: null,
        guestNote: null,
        comment: null,
        notifiedCharges: [],
        listing: { name: 'Airbnb stay', aliases: [] },
      },
    ]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-maveo',
      amount: 475.25,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'MAVEO GmbH',
      reference: 'RE-2026-23-128 | MAVEO GmbH | income',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(result.best?.hostawayId).toBe(64501796);
    expect(result.candidates.every((c) => c.hostawayId === 64501796)).toBe(true);
    expect(result.best?.reasons.join(' ')).toMatch(/deposit|installment/i);
    expect(result.decision).toBe('UNAMBIGUOUS');
  });

  it('loads candidate reservations up to 2 years ahead', async () => {
    prisma.reservation.findMany.mockResolvedValue([]);

    await service.match({
      source: 'QONTO',
      externalId: 'qonto-lookahead',
      amount: 100,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'Test Guest',
      reference: 'test',
      rawPayload: {},
    });

    const args = prisma.reservation.findMany.mock.calls[0][0];
    const lookahead = args.where.arrivalDate.lte as Date;
    const lookback = args.where.departureDate.gte as Date;
    const now = Date.now();
    const daysAhead = (lookahead.getTime() - now) / (24 * 60 * 60 * 1000);
    const daysBack = (now - lookback.getTime()) / (24 * 60 * 60 * 1000);

    expect(daysAhead).toBeGreaterThan(700);
    expect(daysAhead).toBeLessThan(740);
    expect(daysBack).toBeGreaterThan(25);
    expect(daysBack).toBeLessThan(35);
    expect(args.take).toBe(2000);
  });

  it('matches payments for stays about 2 years ahead', async () => {
    prisma.reservation.findMany.mockResolvedValue([
      {
        id: 'res-merz',
        hostawayId: 70000001,
        guestName: 'Siegfried Merz',
        guestEmail: null,
        arrivalDate: new Date('2028-06-03'),
        departureDate: new Date('2028-06-08'),
        totalPrice: 985.25,
        hostNote: null,
        guestNote: null,
        comment: null,
        notifiedCharges: [],
        listing: { name: 'Apartment Merz', aliases: [] },
      },
      {
        id: 'res-other',
        hostawayId: 56520057,
        guestName: 'Kristina Peter',
        guestEmail: null,
        arrivalDate: new Date('2026-10-13'),
        departureDate: new Date('2026-10-17'),
        totalPrice: 985.47,
        hostNote: null,
        guestNote: null,
        comment: null,
        notifiedCharges: [],
        listing: { name: 'Porschewerk', aliases: [] },
      },
    ]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-merz-2028',
      amount: 985.25,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'SIEGFRIED MERZ',
      reference:
        'Betreff: RE-2026-23-115 Buchung 03.06.-08.06.2028. Referenz QY74MWX | SIEGFRIED MERZ | income',
      rawPayload: {},
    };

    const result = await service.match(payment);
    expect(result.best?.hostawayId).toBe(70000001);
    expect(result.best?.reasons.some((r) => /stay dates appear/i.test(r))).toBe(
      true,
    );
  });

  it('excludes inquiry statuses from match candidates', async () => {
    prisma.reservation.findMany.mockResolvedValue([]);

    const payment: NormalizedExternalPayment = {
      source: 'QONTO',
      externalId: 'qonto-inquiry-filter',
      amount: 100,
      currency: 'EUR',
      occurredAt: new Date(),
      payerName: 'Test Guest',
      reference: 'Reservierung 999',
      rawPayload: {},
    };

    await service.match(payment);
    expect(prisma.reservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            notIn: expect.arrayContaining([
              'inquiry',
              'inquiryPreapproved',
              'cancelled',
            ]),
          },
        }),
      }),
    );
  });
});

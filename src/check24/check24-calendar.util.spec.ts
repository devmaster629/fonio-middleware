import {
  buildAvailabilityRanges,
  buildStandardPricingRanges,
} from './check24-calendar.util';

function day(ymd: string, isAvailable: boolean, price: number | null, minNights: number | null = 2) {
  return {
    date: new Date(`${ymd}T00:00:00.000Z`),
    isAvailable,
    price,
    minNights,
  };
}

describe('check24-calendar.util', () => {
  it('collapses consecutive open days with same minStay', () => {
    const ranges = buildAvailabilityRanges([
      day('2026-08-01', true, 100, 2),
      day('2026-08-02', true, 100, 2),
      day('2026-08-03', false, 100, 2),
      day('2026-08-04', true, 120, 3),
    ]);
    expect(ranges).toEqual([
      {
        dateFrom: '2026-08-01',
        dateTo: '2026-08-02',
        availability: 'open',
        minStay: 2,
        checkinPossible: true,
        checkoutPossible: true,
      },
      {
        dateFrom: '2026-08-03',
        dateTo: '2026-08-03',
        availability: 'closed',
        minStay: 2,
        checkinPossible: false,
        checkoutPossible: true,
      },
      {
        dateFrom: '2026-08-04',
        dateTo: '2026-08-04',
        availability: 'open',
        minStay: 3,
        checkinPossible: true,
        checkoutPossible: true,
      },
    ]);
  });

  it('collapses consecutive same prices', () => {
    const ranges = buildStandardPricingRanges([
      day('2026-08-01', true, 100),
      day('2026-08-02', true, 100),
      day('2026-08-03', true, 150),
      day('2026-08-04', true, null),
    ]);
    expect(ranges).toEqual([
      { dateFrom: '2026-08-01', dateTo: '2026-08-02', dailyPrice: 100 },
      { dateFrom: '2026-08-03', dateTo: '2026-08-03', dailyPrice: 150 },
    ]);
  });
});

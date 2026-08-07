import { Check24Availability, Check24StandardPricing } from './check24.types';

export interface LocalCalendarDay {
  date: Date;
  isAvailable: boolean;
  minNights: number | null;
  price: number | null;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Collapse consecutive calendar days with same open/closed + minStay into ranges. */
export function buildAvailabilityRanges(
  days: LocalCalendarDay[],
): Check24Availability[] {
  if (days.length === 0) return [];

  const sorted = [...days].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const ranges: Check24Availability[] = [];

  let start = sorted[0];
  let end = sorted[0];
  let open = sorted[0].isAvailable;
  let minStay = sorted[0].minNights ?? undefined;

  const flush = () => {
    ranges.push({
      dateFrom: ymd(start.date),
      dateTo: ymd(end.date),
      availability: open ? 'open' : 'closed',
      ...(minStay != null ? { minStay } : {}),
      checkinPossible: open,
      checkoutPossible: true,
    });
  };

  for (let i = 1; i < sorted.length; i++) {
    const day = sorted[i];
    const expectedNext = addDays(end.date, 1);
    const same =
      day.isAvailable === open &&
      (day.minNights ?? undefined) === minStay &&
      ymd(day.date) === ymd(expectedNext);

    if (same) {
      end = day;
      continue;
    }
    flush();
    start = day;
    end = day;
    open = day.isAvailable;
    minStay = day.minNights ?? undefined;
  }
  flush();
  return ranges;
}

/** Collapse consecutive days with the same nightly price into standardPricing ranges. */
export function buildStandardPricingRanges(
  days: LocalCalendarDay[],
): Check24StandardPricing[] {
  const priced = days
    .filter((d) => d.price != null && d.price > 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (priced.length === 0) return [];

  const ranges: Check24StandardPricing[] = [];
  let start = priced[0];
  let end = priced[0];
  let price = priced[0].price as number;

  const flush = () => {
    ranges.push({
      dateFrom: ymd(start.date),
      dateTo: ymd(end.date),
      dailyPrice: price,
    });
  };

  for (let i = 1; i < priced.length; i++) {
    const day = priced[i];
    const expectedNext = addDays(end.date, 1);
    const same =
      day.price === price && ymd(day.date) === ymd(expectedNext);
    if (same) {
      end = day;
      continue;
    }
    flush();
    start = day;
    end = day;
    price = day.price as number;
  }
  flush();
  return ranges;
}

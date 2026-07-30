type CandidateLike = {
  hostawayId?: number;
  guestName?: string | null;
  listingName?: string | null;
  arrivalDate?: string | null;
  departureDate?: string | null;
  totalPrice?: number | null;
  balanceDue?: number | null;
};

export type CombinedDepositHint = {
  reservationHostawayIds: number[];
  suggestedAmounts: number[];
  guestName: string;
  reason: string;
};

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function guestsLikelySame(
  a?: string | null,
  b?: string | null,
): boolean {
  if (!a || !b) return false;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const partsA = na.split(' ').filter(Boolean);
  const partsB = nb.split(' ').filter(Boolean);
  const lastA = partsA[partsA.length - 1];
  const lastB = partsB[partsB.length - 1];
  if (lastA.length >= 3 && lastA === lastB) {
    // Same last name and at least one shared token (first name / middle).
    return partsA.some((p) => p.length >= 2 && partsB.includes(p));
  }
  return false;
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function staysOverlapOrSame(
  aArrival?: string | null,
  aDeparture?: string | null,
  bArrival?: string | null,
  bDeparture?: string | null,
): boolean {
  const a0 = parseDate(aArrival);
  const a1 = parseDate(aDeparture);
  const b0 = parseDate(bArrival);
  const b1 = parseDate(bDeparture);
  if (!a0 || !a1 || !b0 || !b1) return false;
  // Inclusive overlap of stay intervals.
  return a0.getTime() <= b1.getTime() && b0.getTime() <= a1.getTime();
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function suggestSplitAmounts(
  paymentAmount: number,
  left: CandidateLike,
  right: CandidateLike,
): number[] | null {
  const totals = [Number(left.totalPrice), Number(right.totalPrice)];
  if (totals.every((v) => Number.isFinite(v) && v > 0)) {
    // Deposits are typically 25% of each booking total (combined transfer).
    const deposits = totals.map((v) => roundMoney(v * 0.25));
    if (Math.abs(deposits[0] + deposits[1] - paymentAmount) <= 2.01) {
      return deposits;
    }
  }

  const balances = [Number(left.balanceDue), Number(right.balanceDue)];
  if (
    balances.every((v) => Number.isFinite(v) && v > 0) &&
    Math.abs(balances[0] + balances[1] - paymentAmount) <= 1.01
  ) {
    return [roundMoney(balances[0]), roundMoney(balances[1])];
  }

  if (totals.every((v) => Number.isFinite(v) && v > 0)) {
    const sum = totals[0] + totals[1];
    const first = roundMoney((paymentAmount * totals[0]) / sum);
    const second = roundMoney(paymentAmount - first);
    if (first >= 0.01 && second >= 0.01) return [first, second];
  }

  const first = roundMoney(paymentAmount / 2);
  const second = roundMoney(paymentAmount - first);
  if (first >= 0.01 && second >= 0.01) return [first, second];
  return null;
}

/**
 * Soft hint only: never used for auto-apply.
 * Detects two same-guest, overlapping-stay bookings on different listings —
 * typical combined deposit for two apartments.
 */
export function detectCombinedDepositHint(
  paymentAmount: number,
  candidates: CandidateLike[],
): CombinedDepositHint | null {
  const list = (candidates || [])
    .map((c) => ({
      ...c,
      hostawayId: Number(c.hostawayId),
    }))
    .filter((c) => Number.isFinite(c.hostawayId) && c.hostawayId > 0)
    .slice(0, 8);

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (!guestsLikelySame(a.guestName, b.guestName)) continue;
      if (
        !staysOverlapOrSame(
          a.arrivalDate,
          a.departureDate,
          b.arrivalDate,
          b.departureDate,
        )
      ) {
        continue;
      }
      const listingA = String(a.listingName || '').trim().toLowerCase();
      const listingB = String(b.listingName || '').trim().toLowerCase();
      if (listingA && listingB && listingA === listingB) continue;

      const suggestedAmounts = suggestSplitAmounts(paymentAmount, a, b);
      if (!suggestedAmounts) continue;

      return {
        reservationHostawayIds: [a.hostawayId, b.hostawayId],
        suggestedAmounts,
        guestName: String(a.guestName || b.guestName || '').trim(),
        reason:
          'Same guest and overlapping stay across two listings — payment may be a combined deposit.',
      };
    }
  }
  return null;
}

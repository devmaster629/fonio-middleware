import {
  detectCombinedDepositHint,
  guestsLikelySame,
  staysOverlapOrSame,
} from './payment-split-hint.util';

describe('guestsLikelySame', () => {
  it('matches identical names', () => {
    expect(guestsLikelySame('Anna Müller', 'Anna Müller')).toBe(true);
  });

  it('matches accent / case variants', () => {
    expect(guestsLikelySame('Anna Müller', 'anna muller')).toBe(true);
  });

  it('rejects different guests', () => {
    expect(guestsLikelySame('Anna Müller', 'Peter Schmidt')).toBe(false);
  });
});

describe('staysOverlapOrSame', () => {
  it('detects overlapping stays', () => {
    expect(
      staysOverlapOrSame('2026-08-01', '2026-08-08', '2026-08-05', '2026-08-12'),
    ).toBe(true);
  });

  it('detects identical stays', () => {
    expect(
      staysOverlapOrSame('2026-08-01', '2026-08-08', '2026-08-01', '2026-08-08'),
    ).toBe(true);
  });

  it('rejects non-overlapping stays', () => {
    expect(
      staysOverlapOrSame('2026-08-01', '2026-08-05', '2026-08-10', '2026-08-15'),
    ).toBe(false);
  });
});

describe('detectCombinedDepositHint', () => {
  const candidates = [
    {
      hostawayId: 101,
      guestName: 'Anna Müller',
      listingName: 'Apartment A',
      arrivalDate: '2026-08-01',
      departureDate: '2026-08-08',
      totalPrice: 800,
      balanceDue: 200,
    },
    {
      hostawayId: 202,
      guestName: 'Anna Müller',
      listingName: 'Apartment B',
      arrivalDate: '2026-08-01',
      departureDate: '2026-08-08',
      totalPrice: 600,
      balanceDue: 150,
    },
  ];

  it('suggests a split for same guest + overlapping stay on two listings', () => {
    const hint = detectCombinedDepositHint(350, candidates);
    expect(hint).not.toBeNull();
    expect(hint?.reservationHostawayIds).toEqual([101, 202]);
    expect(hint?.suggestedAmounts).toEqual([200, 150]);
    expect(hint?.guestName).toBe('Anna Müller');
  });

  it('does not suggest when listings are the same', () => {
    const sameListing = candidates.map((c) => ({
      ...c,
      listingName: 'Apartment A',
    }));
    expect(detectCombinedDepositHint(350, sameListing)).toBeNull();
  });

  it('does not suggest for unrelated guests', () => {
    const differentGuests = [
      candidates[0],
      { ...candidates[1], guestName: 'Peter Schmidt' },
    ];
    expect(detectCombinedDepositHint(350, differentGuests)).toBeNull();
  });
});

import { FonioAvailabilityService } from './fonio-availability.service';

describe('FonioAvailabilityService.enumerateWeekends', () => {
  const service = Object.create(
    FonioAvailabilityService.prototype,
  ) as FonioAvailabilityService;

  it('lists Fri→Sun weekends for October 2026', () => {
    const weekends = service.enumerateWeekends(2026, 10, 2);
    expect(weekends).toEqual([
      { checkIn: '2026-10-02', checkOut: '2026-10-04' },
      { checkIn: '2026-10-09', checkOut: '2026-10-11' },
      { checkIn: '2026-10-16', checkOut: '2026-10-18' },
      { checkIn: '2026-10-23', checkOut: '2026-10-25' },
      { checkIn: '2026-10-30', checkOut: '2026-11-01' },
    ]);
  });

  it('supports Fri→Mon (3 nights)', () => {
    const weekends = service.enumerateWeekends(2026, 10, 3);
    expect(weekends[1]).toEqual({
      checkIn: '2026-10-09',
      checkOut: '2026-10-12',
    });
  });

  it('scans a whole year when month is omitted', () => {
    const weekends = service.enumerateWeekends(2027, undefined, 2);
    expect(weekends.length).toBeGreaterThanOrEqual(52);
    expect(weekends[0].checkIn.startsWith('2027-')).toBe(true);
    expect(weekends.at(-1)?.checkIn.startsWith('2027-')).toBe(true);
  });
});

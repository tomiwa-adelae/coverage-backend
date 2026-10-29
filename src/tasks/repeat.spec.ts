import { nextOccurrence } from './repeat';

describe('nextOccurrence', () => {
  it('moves weekly tasks on 7 days', () => {
    expect(nextOccurrence('2026-10-29', 'WEEKLY')).toBe('2026-11-05');
  });

  it('keeps the day of the month, clamped to short months', () => {
    expect(nextOccurrence('2026-10-15', 'MONTHLY')).toBe('2026-11-15');
    expect(nextOccurrence('2027-01-31', 'MONTHLY')).toBe('2027-02-28');
    expect(nextOccurrence('2026-12-10', 'MONTHLY')).toBe('2027-01-10');
  });

  it('skips the weekend for daily tasks', () => {
    expect(nextOccurrence('2026-10-29', 'DAILY')).toBe('2026-10-30');
    expect(nextOccurrence('2026-10-30', 'DAILY')).toBe('2026-11-02');
  });
});

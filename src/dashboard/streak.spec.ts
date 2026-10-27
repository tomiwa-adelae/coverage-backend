import { goalStreak } from './streak';

// 2026-10-27 is a Tuesday.
const TUE = '2026-10-27';

describe('goalStreak', () => {
  it('is zero with no activity', () => {
    expect(goalStreak({}, TUE, 10)).toBe(0);
  });

  it('counts today once the goal is met', () => {
    expect(goalStreak({ [TUE]: 10 }, TUE, 10)).toBe(1);
  });

  it('does not break on an unfinished today', () => {
    expect(goalStreak({ [TUE]: 3, '2026-10-26': 12 }, TUE, 10)).toBe(1);
  });

  it('skips a weekend without breaking', () => {
    // Fri 23, (Sat 24, Sun 25 empty), Mon 26, Tue 27
    const counts = { '2026-10-23': 10, '2026-10-26': 10, [TUE]: 10 };
    expect(goalStreak(counts, TUE, 10)).toBe(3);
  });

  it('adds weekend days when the goal was met', () => {
    const counts = { '2026-10-24': 10, '2026-10-25': 10, '2026-10-26': 10 };
    expect(goalStreak(counts, TUE, 10)).toBe(3);
  });

  it('breaks on a missed weekday', () => {
    const counts = { '2026-10-22': 10, '2026-10-26': 10 }; // Fri 23 missed
    expect(goalStreak(counts, TUE, 10)).toBe(1);
  });
});

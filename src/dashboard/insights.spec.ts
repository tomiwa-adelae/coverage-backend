import {
  addMonths,
  focusScore,
  isStale,
  portfolioByMonth,
  projectTotal,
  targetWindow,
  upcomingBirthdays,
  weightedPipeline,
} from './insights';

describe('targetWindow', () => {
  it('defaults to six months from the start month', () => {
    expect(targetWindow('2026-10-15', null).months).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
    ]);
  });

  it('uses the end date when set', () => {
    expect(targetWindow('2026-10-01', '2026-12-31').endMonth).toBe('2026-12');
  });

  it('adds months across years', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
  });
});

describe('portfolioByMonth', () => {
  it('carries a balance forward until a newer one is entered', () => {
    const series = portfolioByMonth(
      [
        { prospectId: 'a', month: '2026-10', amount: 10 },
        { prospectId: 'b', month: '2026-11', amount: 5 },
        { prospectId: 'a', month: '2026-12', amount: 30 },
      ],
      ['2026-10', '2026-11', '2026-12', '2027-01'],
    );
    expect(series.map((s) => s.total)).toEqual([10, 15, 35, 35]);
  });
});

describe('projectTotal', () => {
  it('extends the trend of recorded months', () => {
    const p = projectTotal(
      [
        { month: '2026-10', total: 20 },
        { month: '2026-11', total: 40 },
        { month: '2026-12', total: 60 },
      ],
      '2026-10',
      '2026-12',
      '2027-03',
    );
    expect(p).toEqual({
      current: 60,
      perMonth: 20,
      projected: 120,
      monthsLeft: 3,
    });
  });

  it('spreads a single month over the months elapsed', () => {
    const p = projectTotal(
      [{ month: '2026-11', total: 30 }],
      '2026-10',
      '2026-11',
      '2027-03',
    );
    expect(p.perMonth).toBe(15);
    expect(p.projected).toBe(30 + 15 * 4);
  });

  it('never projects below zero', () => {
    const p = projectTotal(
      [
        { month: '2026-10', total: 100 },
        { month: '2026-11', total: 10 },
      ],
      '2026-10',
      '2026-11',
      '2027-03',
    );
    expect(p.projected).toBe(0);
  });
});

describe('weightedPipeline', () => {
  it('weights open potential by stage and ignores funded and declined', () => {
    const f = weightedPipeline([
      { stage: 'INTERESTED', tier: 'A', potential: 10_000_000 },
      { stage: 'FORMS_RECEIVED', tier: 'B', potential: 1_000_000 },
      { stage: 'FUNDED', tier: 'A', potential: 50_000_000 },
      { stage: 'DECLINED', tier: 'A', potential: 50_000_000 },
      { stage: 'CONTACTED', tier: null, potential: null },
    ]);
    expect(f.weighted).toBe(3_000_000 + 700_000);
    expect(f.potential).toBe(11_000_000);
    expect(
      f.byStage.find((s) => s.stage === 'CONTACTED')?.missingPotential,
    ).toBe(1);
  });
});

describe('isStale', () => {
  it('flags prospects past their stage limit', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    expect(isStale('INTERESTED', new Date('2026-10-01T12:00:00Z'), now)).toBe(
      29,
    );
    expect(
      isStale('INTERESTED', new Date('2026-10-20T12:00:00Z'), now),
    ).toBeNull();
    expect(isStale('FUNDED', new Date('2026-01-01T12:00:00Z'), now)).toBeNull();
  });
});

describe('focusScore', () => {
  it('ranks a big likely deposit above a small one', () => {
    const big = focusScore(
      {
        stage: 'FORMS_SENT',
        tier: 'A',
        potential: 50_000_000,
        nextDate: '2026-10-30',
      },
      '2026-10-30',
    );
    const small = focusScore(
      {
        stage: 'FORMS_SENT',
        tier: 'C',
        potential: 1_000_000,
        nextDate: '2026-10-30',
      },
      '2026-10-30',
    );
    expect(big).toBeGreaterThan(small);
  });

  it('raises the score the longer a follow-up is late, up to double', () => {
    const base = {
      stage: 'INTERESTED' as const,
      tier: 'B' as const,
      potential: 10_000_000,
    };
    const onTime = focusScore(
      { ...base, nextDate: '2026-10-30' },
      '2026-10-30',
    );
    const weekLate = focusScore(
      { ...base, nextDate: '2026-10-23' },
      '2026-10-30',
    );
    const monthLate = focusScore(
      { ...base, nextDate: '2026-09-30' },
      '2026-10-30',
    );
    expect(weekLate).toBe(onTime * 1.5);
    expect(monthLate).toBe(onTime * 2);
  });
});

describe('upcomingBirthdays', () => {
  it('finds birthdays in the next week, across the year end', () => {
    const list = upcomingBirthdays(
      [
        { name: 'A', birthday: '01-02' },
        { name: 'B', birthday: '12-30' },
        { name: 'C', birthday: '06-01' },
        { name: 'D', birthday: null },
      ],
      '2026-12-29',
    );
    expect(list.map((p) => [p.name, p.inDays])).toEqual([
      ['B', 1],
      ['A', 4],
    ]);
  });
});

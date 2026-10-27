import { Stage, Tier } from '@prisma/client';
import { addDays, toDate } from '../common/dates';

// Pure calculations behind the target, forecast and focus list, kept free of the
// database so they can be tested directly.

/** Rough chance that a prospect at this stage ends up funded. */
export const STAGE_PROBABILITY: Record<Stage, number> = {
  IDENTIFIED: 0.05,
  CONTACTED: 0.1,
  INTERESTED: 0.3,
  FORMS_SENT: 0.5,
  FORMS_RECEIVED: 0.7,
  ACCOUNT_OPENED: 0.85,
  FUNDED: 1,
  DECLINED: 0,
};

/** Days in a stage before a prospect counts as stuck. */
export const STALE_AFTER_DAYS: Partial<Record<Stage, number>> = {
  IDENTIFIED: 14,
  CONTACTED: 14,
  INTERESTED: 21,
  FORMS_SENT: 10,
  FORMS_RECEIVED: 7,
  ACCOUNT_OPENED: 14,
};

/** Stand-in deposit size when no potential is entered, by tier. */
const TIER_GUESS: Record<Tier | 'NONE', number> = {
  A: 50_000_000,
  B: 10_000_000,
  C: 2_000_000,
  NONE: 5_000_000,
};

export const ym = (ymd: string) => ymd.slice(0, 7);

export function addMonths(month: string, n: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function monthsBetween(from: string, to: string) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/** The measurement window: start month to end month inclusive (default six months). */
export function targetWindow(start: string, end: string | null) {
  const startMonth = ym(start);
  const endMonth = end ? ym(end) : addMonths(startMonth, 5);
  const months: string[] = [];
  for (let m = startMonth; m <= endMonth; m = addMonths(m, 1)) months.push(m);
  return { startMonth, endMonth, months };
}

export interface BalancePoint {
  prospectId: string;
  month: string;
  amount: number;
}

/**
 * Portfolio total per month. A customer's balance carries forward until a newer one
 * is entered, so skipping a month doesn't make their money disappear.
 */
export function portfolioByMonth(points: BalancePoint[], months: string[]) {
  const byProspect = new Map<string, BalancePoint[]>();
  for (const p of points) {
    const list = byProspect.get(p.prospectId) ?? [];
    list.push(p);
    byProspect.set(p.prospectId, list);
  }
  for (const list of byProspect.values())
    list.sort((a, b) => a.month.localeCompare(b.month));

  return months.map((month) => {
    let total = 0;
    for (const list of byProspect.values()) {
      let latest: BalancePoint | undefined;
      for (const p of list) if (p.month <= month) latest = p;
      total += latest?.amount ?? 0;
    }
    return { month, total };
  });
}

/**
 * Where the portfolio will be at the end month at the current pace. Uses the
 * least-squares trend of the months recorded so far; with a single month, the pace
 * is that balance spread over the months since the start.
 */
export function projectTotal(
  series: { month: string; total: number }[],
  startMonth: string,
  currentMonth: string,
  endMonth: string,
) {
  const sofar = series.filter((s) => s.month <= currentMonth);
  const current = sofar.at(-1)?.total ?? 0;
  const remaining = Math.max(0, monthsBetween(currentMonth, endMonth));
  const elapsed = monthsBetween(startMonth, currentMonth) + 1;

  let perMonth: number;
  const points = sofar.map((s) => ({
    x: monthsBetween(startMonth, s.month),
    y: s.total,
  }));
  if (points.length >= 2) {
    const n = points.length;
    const mx = points.reduce((a, p) => a + p.x, 0) / n;
    const my = points.reduce((a, p) => a + p.y, 0) / n;
    const num = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
    const den = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
    perMonth = den ? num / den : 0;
  } else {
    perMonth = current / Math.max(1, elapsed);
  }
  return {
    current,
    perMonth: Math.round(perMonth),
    projected: Math.max(0, Math.round(current + perMonth * remaining)),
    monthsLeft: remaining,
  };
}

export interface ForecastProspect {
  stage: Stage;
  tier: Tier | null;
  potential: number | null;
}

/** Potential weighted by the chance of each open prospect funding. */
export function weightedPipeline(prospects: ForecastProspect[]) {
  const open = prospects.filter(
    (p) => p.stage !== Stage.FUNDED && p.stage !== Stage.DECLINED,
  );
  const byStage = (Object.keys(STAGE_PROBABILITY) as Stage[])
    .filter((s) => s !== Stage.FUNDED && s !== Stage.DECLINED)
    .map((stage) => {
      const ps = open.filter((p) => p.stage === stage);
      const potential = ps.reduce((a, p) => a + (p.potential ?? 0), 0);
      return {
        stage,
        count: ps.length,
        potential,
        probability: STAGE_PROBABILITY[stage],
        weighted: Math.round(potential * STAGE_PROBABILITY[stage]),
        missingPotential: ps.filter((p) => !p.potential).length,
      };
    });
  return {
    byStage,
    weighted: byStage.reduce((a, s) => a + s.weighted, 0),
    potential: byStage.reduce((a, s) => a + s.potential, 0),
  };
}

const daysBetween = (from: Date, to: Date) =>
  Math.floor((to.getTime() - from.getTime()) / 864e5);

export function isStale(stage: Stage, stageChangedAt: Date, now = new Date()) {
  const limit = STALE_AFTER_DAYS[stage];
  const days = daysBetween(stageChangedAt, now);
  return limit !== undefined && days > limit ? days : null;
}

export interface FocusInput {
  stage: Stage;
  tier: Tier | null;
  potential: number | null;
  nextDate: string | null;
}

/**
 * Expected value of reaching out today: likely deposit × chance it lands, nudged up
 * the longer a follow-up has slipped (at most double, after two weeks late).
 */
export function focusScore(p: FocusInput, today: string) {
  const size = p.potential ?? TIER_GUESS[p.tier ?? 'NONE'];
  const late =
    p.nextDate && p.nextDate < today
      ? Math.min(14, daysBetween(toDate(p.nextDate), toDate(today)))
      : 0;
  // Untouched prospects still deserve a call, so never weight below 10%.
  const chance = Math.max(0.1, STAGE_PROBABILITY[p.stage]);
  return Math.round(size * chance * (1 + late / 14));
}

/** Birthdays ("MM-DD") falling within the next `days` days, soonest first. */
export function upcomingBirthdays<T extends { birthday: string | null }>(
  people: T[],
  today: string,
  days = 7,
) {
  const window = Array.from({ length: days + 1 }, (_, i) =>
    addDays(today, i).slice(5),
  );
  return people
    .filter((p) => p.birthday && window.includes(p.birthday))
    .map((p) => ({ ...p, inDays: window.indexOf(p.birthday!) }))
    .sort((a, b) => a.inDays - b.inDays);
}

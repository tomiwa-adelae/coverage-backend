import { Injectable } from '@nestjs/common';
import { ActivityType, Prospect, Stage, Tier } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  addDays,
  localDate,
  startOfDay,
  todayIn,
  weekStart,
} from '../common/dates';
import { byPriority } from '../prospects/prospects.service';
import { serializeProspect } from '../prospects/prospect.serializer';
import { goalStreak } from './streak';
import {
  STALE_AFTER_DAYS,
  focusScore,
  isStale,
  portfolioByMonth,
  projectTotal,
  targetWindow,
  upcomingBirthdays,
  weightedPipeline,
  ym,
} from './insights';

const OPENED: Stage[] = [Stage.ACCOUNT_OPENED, Stage.FUNDED];
const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const num = (v: bigint | null) => (v === null ? null : Number(v));

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  /**
   * Real balances against the target: the month-by-month portfolio, where it lands
   * at the current pace, and how much the open pipeline is likely to add.
   */
  async target(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        timezone: true,
        targetAmount: true,
        targetStartDate: true,
        targetEndDate: true,
      },
    });
    const today = todayIn(user.timezone);
    const start = day(user.targetStartDate)!;
    const window = targetWindow(start, day(user.targetEndDate));
    const currentMonth =
      ym(today) < window.startMonth
        ? window.startMonth
        : ym(today) > window.endMonth
          ? window.endMonth
          : ym(today);

    const [balances, prospects] = await Promise.all([
      this.prisma.balance.findMany({
        where: { userId },
        select: { prospectId: true, month: true, amount: true },
      }),
      this.prisma.prospect.findMany({
        where: { ownerId: userId },
        select: { stage: true, tier: true, potential: true },
      }),
    ]);
    const series = portfolioByMonth(
      balances.map((b) => ({
        prospectId: b.prospectId,
        month: ym(day(b.month)!),
        amount: Number(b.amount),
      })),
      window.months,
    );
    const pace = projectTotal(
      series,
      window.startMonth,
      currentMonth,
      window.endMonth,
    );
    const targetAmount = Number(user.targetAmount);
    const sofar = series.filter((s) => s.month <= currentMonth);
    const forecast = weightedPipeline(
      prospects.map((p) => ({ ...p, potential: num(p.potential) })),
    );
    const gap = Math.max(0, targetAmount - pace.current);
    return {
      today,
      target: targetAmount,
      startMonth: window.startMonth,
      endMonth: window.endMonth,
      currentMonth,
      series,
      current: pace.current,
      average: sofar.length
        ? Math.round(sofar.reduce((a, s) => a + s.total, 0) / sofar.length)
        : 0,
      perMonth: pace.perMonth,
      projected: pace.projected,
      monthsLeft: pace.monthsLeft,
      onPace: pace.projected >= targetAmount,
      gap,
      // What each remaining month has to add to finish on target.
      neededPerMonth: pace.monthsLeft ? Math.ceil(gap / pace.monthsLeft) : gap,
      forecast: {
        ...forecast,
        // Current balance plus what the pipeline is likely to bring in.
        expected: pace.current + forecast.weighted,
        coverage: gap ? forecast.weighted / gap : 1,
      },
    };
  }

  /** Everything the RM should act on, ranked by what it is likely to be worth. */
  async today(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true, dailyGoal: true },
    });
    const today = todayIn(user.timezone);
    const weekOut = addDays(today, 7);

    const open = await this.prisma.prospect.findMany({
      where: { ownerId: userId, stage: { notIn: [Stage.DECLINED] } },
    });
    const sortByDate = (a: Prospect, b: Prospect) =>
      (day(a.nextDate) ?? '').localeCompare(day(b.nextDate) ?? '') ||
      byPriority(a, b);
    const score = (p: Prospect) =>
      focusScore(
        {
          stage: p.stage,
          tier: p.tier,
          potential: num(p.potential),
          nextDate: day(p.nextDate),
        },
        today,
      );
    const byScore = (a: Prospect, b: Prospect) =>
      score(b) - score(a) || byPriority(a, b);

    const overdue = open.filter((p) => p.nextDate && day(p.nextDate)! < today);
    const dueToday = open.filter((p) => day(p.nextDate) === today);
    const upcoming = open.filter((p) => {
      const d = day(p.nextDate);
      return d && d > today && d <= weekOut;
    });
    // Funded accounts still need nurturing, but they are not an urgent gap.
    const noNextStep = open.filter(
      (p) => p.tier && !p.nextDate && p.stage !== Stage.FUNDED,
    );
    const unrated = open.filter((p) => !p.tier);
    const now = new Date();
    const stale = open
      .map((p) => ({ p, days: isStale(p.stage, p.stageChangedAt, now) }))
      .filter((s) => s.days !== null)
      .sort((a, b) => byScore(a.p, b.p));
    const birthdays = upcomingBirthdays(
      open.map((p) => ({ ...serializeProspect(p) })),
      today,
    );

    // A year of touches is enough for any realistic streak.
    const touches = await this.prisma.activity.findMany({
      where: {
        userId,
        type: { not: ActivityType.STAGE_CHANGE },
        occurredAt: { gte: startOfDay(addDays(today, -366), user.timezone) },
      },
      select: { occurredAt: true },
    });
    const counts: Record<string, number> = {};
    for (const t of touches) {
      const d = localDate(user.timezone, t.occurredAt);
      counts[d] = (counts[d] ?? 0) + 1;
    }
    const monday = weekStart(today);
    const week = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(monday, i);
      return { date, touches: counts[date] ?? 0 };
    });

    const out = (list: Prospect[], sort = byPriority) =>
      list.sort(sort).map(serializeProspect);
    const target = await this.target(userId);
    return {
      today,
      touchesToday: counts[today] ?? 0,
      goal: {
        daily: user.dailyGoal,
        streak: goalStreak(counts, today, user.dailyGoal),
        week,
      },
      pace: {
        current: target.current,
        target: target.target,
        projected: target.projected,
        onPace: target.onPace,
        endMonth: target.endMonth,
      },
      // Overdue and due today together, most valuable first.
      focus: [...overdue, ...dueToday]
        .sort(byScore)
        .map((p) => ({ ...serializeProspect(p), score: score(p) })),
      overdue: out(overdue, byScore),
      dueToday: out(dueToday, byScore),
      // Today's follow-ups that have a time, in time order.
      appointments: dueToday
        .filter((p) => p.nextTime)
        .sort((a, b) => a.nextTime!.localeCompare(b.nextTime!))
        .map(serializeProspect),
      noNextStep: out(noNextStep),
      upcoming: out(upcoming, sortByDate),
      unrated: out(unrated, (a, b) => a.name.localeCompare(b.name)),
      stale: stale.slice(0, 10).map((s) => ({
        ...serializeProspect(s.p),
        daysInStage: s.days!,
        staleAfter: STALE_AFTER_DAYS[s.p.stage]!,
      })),
      staleCount: stale.length,
      birthdays,
    };
  }

  async progress(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    const today = todayIn(user.timezone);
    const thisWeek = weekStart(today);
    const firstWeek = addDays(thisWeek, -7 * 7);

    const [prospects, touches, firstOpenings, target] = await Promise.all([
      this.prisma.prospect.findMany({
        where: { ownerId: userId },
        select: {
          id: true,
          stage: true,
          tier: true,
          potential: true,
          funded: true,
          source: true,
          outcomeReason: true,
          wantsProducts: true,
          holdsProducts: true,
          createdAt: true,
        },
      }),
      this.prisma.activity.findMany({
        where: {
          userId,
          type: { not: ActivityType.STAGE_CHANGE },
          occurredAt: { gte: startOfDay(firstWeek, user.timezone) },
        },
        select: { occurredAt: true },
      }),
      // First time each prospect reached an opened account, for time-to-open
      // and the weekly count (a jump straight to Funded still counts once).
      this.prisma.activity.groupBy({
        by: ['prospectId'],
        where: {
          userId,
          type: ActivityType.STAGE_CHANGE,
          toStage: { in: OPENED },
        },
        _min: { occurredAt: true },
      }),
      this.target(userId),
    ]);

    const sum = (xs: (bigint | null)[]) =>
      Number(xs.reduce<bigint>((a, b) => a + (b ?? 0n), 0n));
    const localDay = (d: Date) => localDate(user.timezone, d);

    const weeks = Array.from({ length: 8 }, (_, i) => {
      const start = addDays(firstWeek, i * 7);
      const end = addDays(start, 7);
      const inWeek = (d: Date) => {
        const l = localDay(d);
        return l >= start && l < end;
      };
      return {
        weekStart: start,
        touches: touches.filter((t) => inWeek(t.occurredAt)).length,
        accountsOpened: firstOpenings.filter(
          (o) => o._min.occurredAt && inWeek(o._min.occurredAt),
        ).length,
      };
    });

    const live = prospects.filter((p) => p.stage !== Stage.DECLINED);
    const won = (p: { stage: Stage }) => OPENED.includes(p.stage);

    // Which sources turn into customers.
    const sources = [...new Set(prospects.map((p) => p.source))];
    const bySource = sources
      .map((source) => {
        const ps = prospects.filter((p) => p.source === source);
        const decided = ps.filter((p) => won(p) || p.stage === Stage.DECLINED);
        return {
          source,
          count: ps.length,
          won: ps.filter(won).length,
          lost: ps.filter((p) => p.stage === Stage.DECLINED).length,
          winRate: decided.length
            ? ps.filter(won).length / decided.length
            : null,
          balance: sum(ps.map((p) => p.funded)),
        };
      })
      .sort((a, b) => b.count - a.count);

    const reasons = (ps: typeof prospects) => {
      const counts = new Map<string, number>();
      for (const p of ps) {
        const r = p.outcomeReason?.trim();
        if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
      }
      return [...counts]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
    };

    const created = new Map(prospects.map((p) => [p.id, p.createdAt]));
    const daysToOpen = firstOpenings
      .map((o) => {
        const c = created.get(o.prospectId);
        return c && o._min.occurredAt
          ? (o._min.occurredAt.getTime() - c.getTime()) / 864e5
          : null;
      })
      .filter((d): d is number => d !== null);

    // Products people want that they don't hold yet: the cross-sell list.
    const demand = new Map<string, { wanted: number; held: number }>();
    for (const p of prospects) {
      for (const w of p.wantsProducts) {
        const d = demand.get(w) ?? { wanted: 0, held: 0 };
        if (!p.holdsProducts.includes(w)) d.wanted++;
        demand.set(w, d);
      }
      for (const h of p.holdsProducts) {
        const d = demand.get(h) ?? { wanted: 0, held: 0 };
        d.held++;
        demand.set(h, d);
      }
    }

    return {
      today,
      target: target.target,
      targetStartDate: `${target.startMonth}-01`,
      funded: target.current,
      openPotential: sum(
        live.filter((p) => p.stage !== Stage.FUNDED).map((p) => p.potential),
      ),
      accountsOpened: prospects.filter(won).length,
      formsOut: prospects.filter((p) => p.stage === Stage.FORMS_SENT).length,
      touchesThisWeek: weeks[7].touches,
      weeks,
      byStage: Object.values(Stage).map((stage) => ({
        stage,
        count: prospects.filter((p) => p.stage === stage).length,
      })),
      byTier: [Tier.A, Tier.B, Tier.C, null].map((tier) => {
        const ps = live.filter((p) => p.tier === tier);
        return {
          tier,
          count: ps.length,
          potential: sum(ps.map((p) => p.potential)),
        };
      }),
      targetStatus: target,
      bySource,
      lostReasons: reasons(prospects.filter((p) => p.stage === Stage.DECLINED)),
      wonReasons: reasons(prospects.filter(won)),
      avgDaysToOpen: daysToOpen.length
        ? Math.round(daysToOpen.reduce((a, b) => a + b, 0) / daysToOpen.length)
        : null,
      products: [...demand]
        .map(([product, d]) => ({ product, ...d }))
        .sort((a, b) => b.wanted - a.wanted),
    };
  }
}

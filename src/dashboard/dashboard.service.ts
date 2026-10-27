import { Injectable } from '@nestjs/common';
import { ActivityType, Stage, Tier } from '@prisma/client';
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

const OPENED: Stage[] = [Stage.ACCOUNT_OPENED, Stage.FUNDED];

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  /** Everything the RM should act on, bucketed by urgency. */
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
    const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
    const sortByDate = (a: (typeof open)[0], b: (typeof open)[0]) =>
      (day(a.nextDate) ?? '').localeCompare(day(b.nextDate) ?? '') ||
      byPriority(a, b);

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

    const out = (list: typeof open, sort = byPriority) =>
      list.sort(sort).map(serializeProspect);
    return {
      today,
      touchesToday: counts[today] ?? 0,
      goal: {
        daily: user.dailyGoal,
        streak: goalStreak(counts, today, user.dailyGoal),
        week,
      },
      overdue: out(overdue),
      dueToday: out(dueToday),
      noNextStep: out(noNextStep),
      upcoming: out(upcoming, sortByDate),
      unrated: out(unrated, (a, b) => a.name.localeCompare(b.name)),
    };
  }

  async progress(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true, targetAmount: true, targetStartDate: true },
    });
    const today = todayIn(user.timezone);
    const thisWeek = weekStart(today);
    const firstWeek = addDays(thisWeek, -7 * 7);

    const [prospects, touches, openings] = await Promise.all([
      this.prisma.prospect.findMany({
        where: { ownerId: userId },
        select: { stage: true, tier: true, potential: true, funded: true },
      }),
      this.prisma.activity.findMany({
        where: {
          userId,
          type: { not: ActivityType.STAGE_CHANGE },
          occurredAt: { gte: startOfDay(firstWeek, user.timezone) },
        },
        select: { occurredAt: true },
      }),
      this.prisma.activity.findMany({
        where: {
          userId,
          type: ActivityType.STAGE_CHANGE,
          toStage: Stage.ACCOUNT_OPENED,
          occurredAt: { gte: startOfDay(firstWeek, user.timezone) },
        },
        select: { occurredAt: true },
      }),
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
        accountsOpened: openings.filter((t) => inWeek(t.occurredAt)).length,
      };
    });

    const live = prospects.filter((p) => p.stage !== Stage.DECLINED);
    return {
      today,
      target: Number(user.targetAmount),
      targetStartDate: user.targetStartDate.toISOString().slice(0, 10),
      funded: sum(prospects.map((p) => p.funded)),
      openPotential: sum(
        live.filter((p) => p.stage !== Stage.FUNDED).map((p) => p.potential),
      ),
      accountsOpened: prospects.filter((p) => OPENED.includes(p.stage)).length,
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
    };
  }
}

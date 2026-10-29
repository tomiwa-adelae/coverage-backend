import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Stage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, clock, instantOf, localDate, toDate } from '../common/dates';
import { PushService } from './push.service';

/** Reminders for a follow-up more than this late are dropped, not sent. */
const STALE_MS = 60 * 60_000;
/** "How did it go?" goes this long after a booked follow-up's time... */
const CHECK_IN_AFTER_MS = 30 * 60_000;
/** ...unless it's later than this, when it would only be noise. */
const CHECK_IN_UNTIL_MS = 4 * 60 * 60_000;

function localHour(timezone: string, at: Date) {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at),
  );
}

const isWeekend = (ymd: string) =>
  [0, 6].includes(new Date(`${ymd}T12:00:00Z`).getUTCDay());

/**
 * Push reminders for follow-ups that have a time, `reminderLead` minutes before;
 * a "How did it go?" after them if nothing was logged; and a "Debrief your day"
 * on working-day evenings. Runs every 5 minutes; sleeping hosts can call
 * POST /api/jobs/run instead.
 */
@Injectable()
export class ReminderService {
  private log = new Logger('Reminders');
  private running = false;

  constructor(
    private prisma: PrismaService,
    private push: PushService,
  ) {}

  @Cron('*/5 * * * *')
  async tick() {
    await this.runDue().catch((e: Error) => this.log.error(e.message));
  }

  async runDue(now = new Date()) {
    if (this.running || !this.push.configured)
      return { reminders: 0, taskReminders: 0, checkIns: 0, debriefNudges: 0 };
    this.running = true;
    let reminders = 0;
    let checkIns = 0;
    let debriefNudges = 0;
    let taskReminders = 0;
    try {
      taskReminders = await this.taskReminders(now);
      checkIns = await this.checkIns(now);
      debriefNudges = await this.debriefNudges(now);
      // Dates are stored without a timezone, so look a day either side of UTC today.
      const utcToday = now.toISOString().slice(0, 10);
      const due = await this.prisma.prospect.findMany({
        where: {
          nextTime: { not: null },
          nextDate: {
            gte: toDate(addDays(utcToday, -1)),
            lte: toDate(addDays(utcToday, 1)),
          },
          stage: { not: Stage.DECLINED },
          owner: { reminderLead: { gte: 0 } },
        },
        select: {
          id: true,
          name: true,
          company: true,
          nextAction: true,
          nextDate: true,
          nextTime: true,
          remindedFor: true,
          owner: { select: { id: true, timezone: true, reminderLead: true } },
        },
      });

      for (const p of due) {
        const ymd = p.nextDate!.toISOString().slice(0, 10);
        const key = `${ymd} ${p.nextTime}`;
        if (p.remindedFor === key) continue;
        const at = instantOf(ymd, p.nextTime!, p.owner.timezone).getTime();
        if (now.getTime() < at - p.owner.reminderLead * 60_000) continue;

        // Claim it first so overlapping runs can't send twice. A plain
        // `not: key` would skip rows where remindedFor is still NULL.
        const { count } = await this.prisma.prospect.updateMany({
          where: {
            id: p.id,
            OR: [{ remindedFor: null }, { remindedFor: { not: key } }],
          },
          data: { remindedFor: key },
        });
        // Long past (the server was asleep): mark it done without a late buzz.
        if (!count || now.getTime() > at + STALE_MS) continue;

        const mins = Math.round((at - now.getTime()) / 60_000);
        const when =
          mins > 1 ? `In ${mins} min` : mins >= -1 ? 'Now' : `${-mins} min ago`;
        await this.push
          .send(
            p.owner.id,
            {
              title: `${when} · ${p.name}`,
              body: [
                `${clock(p.nextTime!)}: ${p.nextAction || 'Follow up'}`,
                p.company,
              ]
                .filter(Boolean)
                .join(' · '),
              url: `/?p=${p.id}`,
              tag: `reminder-${p.id}`,
            },
            // Worth delivering until shortly after the time, not hours later.
            {
              ttl: (at + 30 * 60_000 - now.getTime()) / 1000,
              urgency: 'high',
            },
          )
          .catch((e: Error) =>
            this.log.error(`reminder ${p.id}: ${e.message}`),
          );
        reminders++;
      }
    } finally {
      this.running = false;
    }
    return { reminders, taskReminders, checkIns, debriefNudges };
  }

  /** To-dos with a time, `reminderLead` minutes before, like follow-ups. */
  private async taskReminders(now: Date) {
    const utcToday = now.toISOString().slice(0, 10);
    const due = await this.prisma.task.findMany({
      where: {
        doneAt: null,
        dueTime: { not: null },
        dueDate: {
          gte: toDate(addDays(utcToday, -1)),
          lte: toDate(addDays(utcToday, 1)),
        },
        owner: { reminderLead: { gte: 0 } },
      },
      select: {
        id: true,
        title: true,
        dueDate: true,
        dueTime: true,
        remindedFor: true,
        prospect: { select: { id: true, name: true } },
        owner: { select: { id: true, timezone: true, reminderLead: true } },
      },
    });
    let sent = 0;
    for (const t of due) {
      const ymd = t.dueDate!.toISOString().slice(0, 10);
      const key = `${ymd} ${t.dueTime}`;
      if (t.remindedFor === key) continue;
      const at = instantOf(ymd, t.dueTime!, t.owner.timezone).getTime();
      if (now.getTime() < at - t.owner.reminderLead * 60_000) continue;
      const { count } = await this.prisma.task.updateMany({
        where: {
          id: t.id,
          OR: [{ remindedFor: null }, { remindedFor: { not: key } }],
        },
        data: { remindedFor: key },
      });
      if (!count || now.getTime() > at + STALE_MS) continue;
      await this.push
        .send(
          t.owner.id,
          {
            title: t.prospect ? `To do · ${t.prospect.name}` : 'To do',
            body: `${clock(t.dueTime!)}: ${t.title}`,
            url: t.prospect ? `/?p=${t.prospect.id}` : '/tasks',
            tag: `task-${t.id}`,
          },
          { ttl: (at + 30 * 60_000 - now.getTime()) / 1000, urgency: 'high' },
        )
        .catch((e: Error) => this.log.error(`task ${t.id}: ${e.message}`));
      sent++;
    }
    return sent;
  }

  /** After a booked follow-up, ask how it went if nothing has been logged. */
  private async checkIns(now: Date) {
    const utcToday = now.toISOString().slice(0, 10);
    const due = await this.prisma.prospect.findMany({
      where: {
        nextTime: { not: null },
        nextDate: {
          gte: toDate(addDays(utcToday, -1)),
          lte: toDate(utcToday),
        },
        stage: { not: Stage.DECLINED },
        owner: { reminderLead: { gte: 0 } },
      },
      select: {
        id: true,
        name: true,
        nextAction: true,
        nextDate: true,
        nextTime: true,
        checkedInFor: true,
        lastContactAt: true,
        owner: { select: { id: true, timezone: true } },
      },
    });
    let sent = 0;
    for (const p of due) {
      const ymd = p.nextDate!.toISOString().slice(0, 10);
      const key = `${ymd} ${p.nextTime}`;
      if (p.checkedInFor === key) continue;
      const at = instantOf(ymd, p.nextTime!, p.owner.timezone).getTime();
      const since = now.getTime() - at;
      if (since < CHECK_IN_AFTER_MS || since > CHECK_IN_UNTIL_MS) continue;
      // Logged on the day already (logging usually moves the date anyway).
      if (p.lastContactAt && p.lastContactAt.getTime() >= at - 3 * 60 * 60_000)
        continue;
      const { count } = await this.prisma.prospect.updateMany({
        where: {
          id: p.id,
          OR: [{ checkedInFor: null }, { checkedInFor: { not: key } }],
        },
        data: { checkedInFor: key },
      });
      if (!count) continue;
      await this.push
        .send(
          p.owner.id,
          {
            title: `How did it go with ${p.name}?`,
            body: `${clock(p.nextTime!)}: ${p.nextAction || 'Follow up'}. Tap to log it.`,
            url: `/?log=${p.id}`,
            tag: `checkin-${p.id}`,
          },
          { ttl: 3 * 60 * 60, urgency: 'normal' },
        )
        .catch((e: Error) => this.log.error(`check-in ${p.id}: ${e.message}`));
      sent++;
    }
    return sent;
  }

  /** Working-day evenings: a nudge to debrief, unless one's been done today. */
  private async debriefNudges(now: Date) {
    const users = await this.prisma.user.findMany({
      where: { debriefHour: { gte: 0 }, pushSubs: { some: {} } },
      select: {
        id: true,
        timezone: true,
        debriefHour: true,
        lastDebriefNudgeOn: true,
      },
    });
    let sent = 0;
    for (const u of users) {
      const today = localDate(u.timezone, now);
      if (u.lastDebriefNudgeOn === today || isWeekend(today)) continue;
      const hour = localHour(u.timezone, now);
      // Within three hours of the chosen time, so a late-waking server still
      // sends, but never in the middle of the night.
      if (hour < u.debriefHour || hour >= Math.min(u.debriefHour + 3, 23))
        continue;
      const { count } = await this.prisma.user.updateMany({
        where: {
          id: u.id,
          OR: [
            { lastDebriefNudgeOn: null },
            { lastDebriefNudgeOn: { not: today } },
          ],
        },
        data: { lastDebriefNudgeOn: today },
      });
      if (!count) continue;
      const done = await this.prisma.debrief.count({
        where: {
          userId: u.id,
          createdAt: { gte: new Date(now.getTime() - 12 * 60 * 60_000) },
        },
      });
      const touches = await this.prisma.activity.count({
        where: {
          prospect: { ownerId: u.id },
          occurredAt: { gte: new Date(now.getTime() - 12 * 60 * 60_000) },
        },
      });
      if (done) continue;
      await this.push
        .send(
          u.id,
          {
            title: 'Debrief your day',
            body: touches
              ? `${touches} contact${touches === 1 ? '' : 's'} logged today. Anything else? Talk it through in two minutes.`
              : 'Talk through who you saw and called today. Coverage updates each record for you.',
            url: '/debrief',
            tag: 'debrief-nudge',
          },
          { ttl: 3 * 60 * 60, urgency: 'normal' },
        )
        .catch((e: Error) => this.log.error(`debrief nudge: ${e.message}`));
      sent++;
    }
    return sent;
  }
}

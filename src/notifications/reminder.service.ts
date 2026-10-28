import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Stage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, clock, instantOf, toDate } from '../common/dates';
import { PushService } from './push.service';

/** Reminders for a follow-up more than this late are dropped, not sent. */
const STALE_MS = 60 * 60_000;

/**
 * Push reminders for follow-ups that have a time, `reminderLead` minutes before.
 * Runs every 5 minutes; sleeping hosts can call POST /api/jobs/run instead.
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
    if (this.running || !this.push.configured) return { reminders: 0 };
    this.running = true;
    let reminders = 0;
    try {
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
    return { reminders };
  }
}

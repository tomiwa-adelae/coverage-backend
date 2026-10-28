import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { MailService, escapeHtml } from '../mail/mail.service';
import { todayIn } from '../common/dates';
import { PushService } from './push.service';
import { clock } from '../common/dates';

const appUrl = () =>
  (
    process.env.APP_URL ||
    process.env.FRONTEND_URL?.split(',')[0] ||
    'http://localhost:3000'
  )
    .trim()
    .replace(/\/$/, '');

const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;

const STAGE_LABEL: Record<string, string> = {
  IDENTIFIED: 'Identified',
  CONTACTED: 'Contacted',
  INTERESTED: 'Interested',
  FORMS_SENT: 'Forms sent',
  FORMS_RECEIVED: 'Forms received',
  ACCOUNT_OPENED: 'Account opened',
  FUNDED: 'Funded',
  DECLINED: 'Declined',
};

function localHour(timezone: string, at = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at),
  );
}

const isMonday = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).getUTCDay() === 1;

/** Shared branded email wrapper. */
function layout(title: string, body: string) {
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;color:#1f2d35">
<div style="background:#30444F;padding:18px 24px;border-radius:12px 12px 0 0"><span style="color:#FDB813;font-weight:700;font-size:18px">Coverage</span><span style="color:#cfd8dc;font-size:13px;margin-left:8px">${escapeHtml(title)}</span></div>
<div style="border:1px solid #e3e8eb;border-top:0;padding:24px;border-radius:0 0 12px 12px;font-size:14px;line-height:1.55">${body}</div></div>`;
}

const button = (href: string, label: string) =>
  `<p style="margin:24px 0 4px"><a href="${href}" style="background:#30444F;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">${label}</a></p>`;

/**
 * The morning summary (push and email) and Monday's report to the manager.
 * Runs every 15 minutes; each user is handled once a day at their chosen local hour.
 * Free hosts that sleep can call POST /api/jobs/run from an external cron instead.
 */
@Injectable()
export class DigestService {
  private log = new Logger('Digest');
  private running = false;

  constructor(
    private prisma: PrismaService,
    private dashboard: DashboardService,
    private mail: MailService,
    private push: PushService,
  ) {}

  @Cron('*/15 * * * *')
  async tick() {
    await this.runDue().catch((e: Error) => this.log.error(e.message));
  }

  async runDue(now = new Date()) {
    if (this.running) return { digests: 0, reports: 0 };
    this.running = true;
    let digests = 0;
    let reports = 0;
    try {
      const users = await this.prisma.user.findMany({
        select: {
          id: true,
          timezone: true,
          digestHour: true,
          digestEmail: true,
          digestPush: true,
          lastDigestOn: true,
          weeklyReport: true,
          managerEmail: true,
          lastReportOn: true,
        },
      });
      for (const u of users) {
        const today = todayIn(u.timezone);
        const hour = localHour(u.timezone, now);
        // Between the chosen hour and noon, so a server that woke late still sends,
        // but nobody gets a "morning" list at night.
        if (hour < u.digestHour || hour >= 12) continue;

        if ((u.digestEmail || u.digestPush) && u.lastDigestOn !== today) {
          // Claim first so overlapping runs can't send twice. NOT on its own
          // never matches NULL, which would skip everyone's first digest.
          const { count } = await this.prisma.user.updateMany({
            where: {
              id: u.id,
              OR: [{ lastDigestOn: null }, { lastDigestOn: { not: today } }],
            },
            data: { lastDigestOn: today },
          });
          if (count) {
            await this.sendDigest(u.id).catch((e: Error) =>
              this.log.error(`digest ${u.id}: ${e.message}`),
            );
            digests++;
          }
        }

        if (
          u.weeklyReport &&
          u.managerEmail &&
          isMonday(today) &&
          u.lastReportOn !== today
        ) {
          const { count } = await this.prisma.user.updateMany({
            where: {
              id: u.id,
              OR: [{ lastReportOn: null }, { lastReportOn: { not: today } }],
            },
            data: { lastReportOn: today },
          });
          if (count) {
            await this.sendWeeklyReport(u.id).catch((e: Error) =>
              this.log.error(`report ${u.id}: ${e.message}`),
            );
            reports++;
          }
        }
      }
    } finally {
      this.running = false;
    }
    return { digests, reports };
  }

  async sendDigest(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const t = await this.dashboard.today(userId);
    const due = t.focus.length;
    const first = user.name.split(' ')[0];

    if (user.digestPush) {
      const top = t.focus
        .slice(0, 3)
        .map((p) => p.name)
        .join(', ');
      const booked = t.appointments
        .slice(0, 3)
        .map((p) => `${clock(p.nextTime!)} ${p.name}`)
        .join(', ');
      await this.push.send(userId, {
        title: due
          ? `${due} follow-up${due === 1 ? '' : 's'} today${t.overdue.length ? ` (${t.overdue.length} overdue)` : ''}`
          : 'Nothing due today',
        body: due
          ? [booked && `Booked: ${booked}.`, `Start with ${top}.`]
              .filter(Boolean)
              .join(' ')
          : 'A good day to add new prospects or plan next steps.',
        url: '/',
        tag: 'digest',
      });
    }

    if (user.digestEmail && this.mail.configured) {
      const rows = t.focus
        .slice(0, 10)
        .map(
          (p) => `<tr>
<td style="padding:8px 0;border-bottom:1px solid #eef1f3"><a href="${appUrl()}/?p=${p.id}" style="color:#1f2d35;font-weight:600;text-decoration:none">${escapeHtml(p.name)}</a><br><span style="color:#5b6b74;font-size:12px">${escapeHtml(p.nextAction || 'Follow up')} · ${STAGE_LABEL[p.stage]}</span></td>
<td style="padding:8px 0;border-bottom:1px solid #eef1f3;text-align:right;font-size:12px;color:${p.nextDate && p.nextDate < t.today ? '#c62828' : '#5b6b74'}">${p.nextDate && p.nextDate < t.today ? 'Overdue' : p.nextTime ? clock(p.nextTime) : 'Today'}${p.potential ? `<br>${naira(p.potential)}` : ''}</td></tr>`,
        )
        .join('');
      const extras = [
        t.birthdays.length
          ? `🎂 ${t.birthdays.map((b) => `${escapeHtml(b.name)} (${b.inDays === 0 ? 'today' : `in ${b.inDays} day${b.inDays === 1 ? '' : 's'}`})`).join(', ')}`
          : '',
        t.staleCount
          ? `${t.staleCount} prospect${t.staleCount === 1 ? ' has' : 's have'} been stuck in a stage too long.`
          : '',
        `Balance ${naira(t.pace.current)} of ${naira(t.pace.target)}: ${t.pace.onPace ? 'on pace' : `on pace for ${naira(t.pace.projected)}`}.`,
      ]
        .filter(Boolean)
        .map((x) => `<p style="margin:8px 0;color:#3d4b52">${x}</p>`)
        .join('');
      await this.mail.send({
        to: user.email,
        fromName: 'Coverage',
        subject: due
          ? `${due} follow-up${due === 1 ? '' : 's'} today, ${first}`
          : `Nothing due today, ${first}`,
        text: [
          `Good morning ${first},`,
          due
            ? 'Your list for today, most valuable first:'
            : 'Nothing is due today.',
          ...t.focus
            .slice(0, 10)
            .map(
              (p) =>
                `- ${p.name}: ${p.nextAction || 'Follow up'}${p.nextTime && p.nextDate === t.today ? ` at ${clock(p.nextTime)}` : ''}`,
            ),
          '',
          `Open Coverage: ${appUrl()}`,
        ].join('\n'),
        html: layout(
          'Your morning list',
          `<p>Good morning ${escapeHtml(first)},</p>
${due ? `<p>${due} follow-up${due === 1 ? '' : 's'} today, most valuable first:</p><table style="width:100%;border-collapse:collapse">${rows}</table>` : '<p>Nothing is due today. A good day to add new prospects or plan next steps.</p>'}
${extras}${button(appUrl(), 'Open Coverage')}
<p style="color:#8a979e;font-size:12px;margin-top:20px">Change or turn off this email in Settings.</p>`,
        ),
      });
    }
  }

  /** Last week's numbers, in the shape the report page and the email both use. */
  async weeklyReport(userId: string) {
    const [user, p] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { name: true, email: true, jobTitle: true, branch: true },
      }),
      this.dashboard.progress(userId),
    ]);
    const lastWeek = p.weeks[6];
    const t = p.targetStatus;
    const top = await this.prisma.prospect.findMany({
      where: {
        ownerId: userId,
        stage: {
          in: ['INTERESTED', 'FORMS_SENT', 'FORMS_RECEIVED', 'ACCOUNT_OPENED'],
        },
        potential: { not: null },
      },
      orderBy: { potential: 'desc' },
      take: 5,
      select: { name: true, company: true, stage: true, potential: true },
    });
    return {
      user,
      weekStart: lastWeek.weekStart,
      contacts: lastWeek.touches,
      accountsOpened: lastWeek.accountsOpened,
      balance: t.current,
      target: t.target,
      projected: t.projected,
      onPace: t.onPace,
      endMonth: t.endMonth,
      weightedPipeline: t.forecast.weighted,
      stages: p.byStage,
      opportunities: top.map((o) => ({ ...o, potential: Number(o.potential) })),
    };
  }

  async sendWeeklyReport(userId: string) {
    const settings = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { managerEmail: true },
    });
    if (!settings.managerEmail || !this.mail.configured) return;
    const r = await this.weeklyReport(userId);
    const line = (label: string, value: string) =>
      `<tr><td style="padding:6px 0;color:#5b6b74">${label}</td><td style="padding:6px 0;text-align:right;font-weight:600">${value}</td></tr>`;
    const opps = r.opportunities
      .map(
        (o) =>
          `<li>${escapeHtml(o.name)}${o.company ? `, ${escapeHtml(o.company)}` : ''}: ${naira(o.potential)} (${STAGE_LABEL[o.stage]})</li>`,
      )
      .join('');
    await this.mail.send({
      to: settings.managerEmail,
      fromName: r.user.name,
      replyTo: r.user.email,
      subject: `Weekly update from ${r.user.name}: week of ${r.weekStart}`,
      text: [
        `Weekly update from ${r.user.name} (week of ${r.weekStart})`,
        `Contacts made: ${r.contacts}`,
        `Accounts opened: ${r.accountsOpened}`,
        `Deposit balance: ${naira(r.balance)} of ${naira(r.target)}`,
        `On pace for: ${naira(r.projected)} by ${r.endMonth}`,
        `Weighted pipeline: ${naira(r.weightedPipeline)}`,
      ].join('\n'),
      html: layout(
        'Weekly update',
        `<p><strong>${escapeHtml(r.user.name)}</strong>${r.user.jobTitle ? `, ${escapeHtml(r.user.jobTitle)}` : ''}${r.user.branch ? ` · ${escapeHtml(r.user.branch)}` : ''}</p>
<p style="color:#5b6b74">Week of ${r.weekStart}</p>
<table style="width:100%;border-collapse:collapse">
${line('Contacts made', String(r.contacts))}
${line('Accounts opened', String(r.accountsOpened))}
${line('Deposit balance', `${naira(r.balance)} of ${naira(r.target)}`)}
${line('On pace for', `${naira(r.projected)} by ${r.endMonth}`)}
${line('Weighted pipeline', naira(r.weightedPipeline))}
</table>
${opps ? `<p style="margin-top:18px;font-weight:600">Biggest open opportunities</p><ul>${opps}</ul>` : ''}`,
      ),
    });
  }
}

import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import { Stage } from '@prisma/client';
import { Client, CurrentUser, Public } from '../common/decorators';
import type { AuthUser, ClientInfo } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { addDays, todayIn } from '../common/dates';
import { buildCalendar } from './ics';

const appUrl = () =>
  (
    process.env.APP_URL ||
    process.env.FRONTEND_URL?.split(',')[0] ||
    'http://localhost:3000'
  )
    .trim()
    .replace(/\/$/, '');

const feedUrl = (token: string) => `${appUrl()}/api/calendar/${token}.ics`;

/**
 * A private, read-only calendar of follow-ups. Google Calendar, Outlook and Apple
 * Calendar subscribe to the URL and refresh it on their own schedule (Google can
 * take several hours). The token is the only secret, so it can be reset.
 */
@Controller('calendar')
export class CalendarController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthUser) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.sub },
      select: { calendarToken: true },
    });
    return { url: u.calendarToken ? feedUrl(u.calendarToken) : null };
  }

  /** Creates the link, or replaces it so the old one stops working. */
  @Post()
  @HttpCode(200)
  async reset(@CurrentUser() user: AuthUser, @Client() client: ClientInfo) {
    const token = randomBytes(24).toString('base64url');
    const before = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.sub },
      select: { calendarToken: true },
    });
    await this.prisma.user.update({
      where: { id: user.sub },
      data: { calendarToken: token },
    });
    if (before.calendarToken)
      await this.audit.record(user.sub, 'calendar.reset', client);
    return { url: feedUrl(token) };
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser) {
    await this.prisma.user.update({
      where: { id: user.sub },
      data: { calendarToken: null },
    });
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':file')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @Header('Cache-Control', 'private, max-age=900')
  async feed(@Param('file') file: string) {
    const token = file.replace(/\.ics$/, '');
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) throw new NotFoundException();
    const user = await this.prisma.user.findUnique({
      where: { calendarToken: token },
      select: { id: true, timezone: true },
    });
    if (!user) throw new NotFoundException();

    const today = todayIn(user.timezone);
    const prospects = await this.prisma.prospect.findMany({
      where: {
        ownerId: user.id,
        stage: { not: Stage.DECLINED },
        nextDate: {
          gte: new Date(`${addDays(today, -30)}T00:00:00Z`),
          lte: new Date(`${addDays(today, 180)}T00:00:00Z`),
        },
      },
      select: {
        id: true,
        name: true,
        company: true,
        phone: true,
        nextAction: true,
        nextDate: true,
      },
    });
    const events = prospects.map((p) => ({
      // Stable per prospect, so a moved follow-up moves the event instead of duplicating it.
      uid: `followup-${p.id}@coverage`,
      date: p.nextDate!.toISOString().slice(0, 10),
      summary: `${p.nextAction || 'Follow up'}: ${p.name}`,
      description: [p.company, p.phone, `${appUrl()}/?p=${p.id}`]
        .filter(Boolean)
        .join('\n'),
      url: `${appUrl()}/?p=${p.id}`,
    }));
    return buildCalendar('Coverage follow-ups', events);
  }
}

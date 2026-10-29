import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActivityType, Prisma, Prospect, Stage, Tier } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, todayIn, toDate } from '../common/dates';
import type { ClientInfo } from '../common/decorators';
import {
  BalanceBatchDto,
  BalanceDto,
  CreateProspectDto,
  ListProspectsQuery,
  LogActivityDto,
  SendEmailDto,
  SendSmsDto,
  UpdateProspectDto,
} from './prospect.dto';
import { serializeProspect } from './prospect.serializer';
import { MailService, textToHtml } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import { AuditService } from '../audit/audit.service';
import { CadencesService } from '../cadences/cadences.service';
import { parseSteps, stepDue } from '../cadences/cadences';
import { toCsv } from '../common/csv';
import { serializeTask, TasksService } from '../tasks/tasks.service';
import { balanceDrops, careDays, looksLikeBusiness } from './care';

/** Default follow-up gap after a contact, by tier. Unrated prospects get a week. */
export const FOLLOW_UP_DAYS: Record<Tier, number> = { A: 7, B: 14, C: 30 };

const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2 };

/** Stages in pipeline order; DECLINED sits outside it. */
export const STAGE_ORDER: Stage[] = [
  Stage.IDENTIFIED,
  Stage.CONTACTED,
  Stage.INTERESTED,
  Stage.FORMS_SENT,
  Stage.FORMS_RECEIVED,
  Stage.ACCOUNT_OPENED,
  Stage.FUNDED,
];

/** Tier first, then biggest potential, then name. */
export function byPriority(
  a: { tier: Tier | null; potential: bigint | null; name: string },
  b: { tier: Tier | null; potential: bigint | null; name: string },
) {
  const t = (TIER_ORDER[a.tier ?? ''] ?? 3) - (TIER_ORDER[b.tier ?? ''] ?? 3);
  if (t) return t;
  const pa = a.potential ?? 0n;
  const pb = b.potential ?? 0n;
  if (pa !== pb) return pb > pa ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/** "2026-10" from "2026-10-27"; months are stored as their first day. */
export const monthOf = (ymd: string) => ymd.slice(0, 7);
export const monthDate = (ym: string) => toDate(`${ym}-01`);

/** Last ten digits, so 0803…, 234803… and +234 803… all match. */
export const phoneKey = (phone: string | null | undefined) => {
  const d = phone?.replace(/\D/g, '') ?? '';
  return d.length >= 7 ? d.slice(-10) : null;
};

function toData(dto: UpdateProspectDto) {
  const blank = (v: string | null | undefined) =>
    v === undefined ? undefined : v?.trim() || null;
  const big = (v: number | null | undefined) =>
    v === undefined ? undefined : v === null ? null : BigInt(v);
  return {
    name: dto.name?.trim(),
    company: blank(dto.company),
    group: blank(dto.group),
    phone: blank(dto.phone),
    email: blank(dto.email),
    tier: dto.tier,
    stage: dto.stage,
    potential: big(dto.potential),
    funded: big(dto.funded),
    nextAction: blank(dto.nextAction),
    nextDate:
      dto.nextDate === undefined
        ? undefined
        : dto.nextDate
          ? toDate(dto.nextDate)
          : null,
    // No date means no time either.
    nextTime: dto.nextDate === null ? null : dto.nextTime,
    notes: blank(dto.notes),
    outcomeReason: blank(dto.outcomeReason),
    source: dto.source,
    wantsProducts: dto.wantsProducts,
    holdsProducts: dto.holdsProducts,
    referredById: dto.referredById,
    birthday: blank(dto.birthday),
    area: blank(dto.area),
    address: blank(dto.address),
    latitude: dto.latitude,
    longitude: dto.longitude,
    consentMethod: dto.consentMethod,
    consentNote: blank(dto.consentNote),
  };
}

@Injectable()
export class ProspectsService {
  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private sms: SmsService,
    private audit: AuditService,
    private cadences: CadencesService,
    private tasks: TasksService,
  ) {}

  /** Forms are out: list the documents still to collect. */
  private async startChecklist(ownerId: string, p: Prospect) {
    // A business by name or products gets the business list; it can be swapped.
    await this.tasks
      .checklistOnFormsSent(ownerId, p.id, looksLikeBusiness(p))
      .catch(() => {});
  }

  async list(ownerId: string, query: ListProspectsQuery) {
    const where: Prisma.ProspectWhereInput = { ownerId };
    if (query.stage) where.stage = query.stage;
    if (query.tier)
      where.tier = query.tier === 'NONE' ? null : (query.tier as Tier);
    if (query.group) where.group = query.group;
    if (query.area) where.area = query.area;
    const q = query.q?.trim();
    if (q) {
      where.OR = (
        [
          'name',
          'company',
          'notes',
          'group',
          'nextAction',
          'email',
          'phone',
          'area',
        ] as const
      ).map((f) => ({ [f]: { contains: q, mode: 'insensitive' } }));
    }
    const rows = await this.prisma.prospect.findMany({ where });
    return rows.sort(byPriority).map(serializeProspect);
  }

  async stageCounts(ownerId: string) {
    const rows = await this.prisma.prospect.groupBy({
      by: ['stage'],
      where: { ownerId },
      _count: true,
    });
    return Object.fromEntries(
      Object.values(Stage).map((s) => [
        s,
        rows.find((r) => r.stage === s)?._count ?? 0,
      ]),
    );
  }

  /** Distinct non-empty values of a text column, for suggestions. */
  async distinct(ownerId: string, field: 'group' | 'area') {
    const rows = await this.prisma.prospect.findMany({
      where: { ownerId, [field]: { not: null } },
      distinct: [field],
      select: { group: true, area: true },
      orderBy: { [field]: 'asc' },
    });
    return rows.map((r) => r[field]!);
  }

  async get(ownerId: string, id: string) {
    const p = await this.prisma.prospect.findFirst({
      where: { id, ownerId },
      include: {
        activities: { orderBy: { occurredAt: 'desc' }, take: 100 },
        referredBy: { select: { id: true, name: true } },
        referrals: {
          select: { id: true, name: true, stage: true },
          orderBy: { name: 'asc' },
        },
        balances: { orderBy: { month: 'desc' }, take: 24 },
        cadence: { select: { id: true, name: true, steps: true } },
        tasks: {
          include: {
            prospect: { select: { id: true, name: true, company: true } },
          },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!p)
      throw new NotFoundException(
        'We couldn’t find that prospect. It may have been deleted.',
      );
    const {
      activities,
      referredBy,
      referrals,
      balances,
      cadence,
      tasks,
      ...rest
    } = p;
    const sameCompany = p.company
      ? await this.prisma.prospect.findMany({
          where: {
            ownerId,
            id: { not: id },
            company: { equals: p.company, mode: 'insensitive' },
          },
          select: { id: true, name: true, stage: true },
          orderBy: { name: 'asc' },
          take: 20,
        })
      : [];
    return {
      ...serializeProspect(rest),
      activities,
      referredBy,
      referrals,
      sameCompany,
      cadence,
      tasks: tasks.map(serializeTask),
      balances: balances.map((b) => ({
        month: monthOf(b.month.toISOString()),
        amount: Number(b.amount),
      })),
    };
  }

  async create(ownerId: string, dto: CreateProspectDto) {
    if (dto.referredById) await this.owned(ownerId, dto.referredById);
    const data = toData(dto);
    const p = await this.prisma.prospect.create({
      data: {
        ...data,
        name: dto.name.trim(),
        ownerId,
        consentAt: dto.consentMethod ? new Date() : undefined,
        wantsProducts: data.wantsProducts ?? [],
        holdsProducts: data.holdsProducts ?? [],
      },
    });
    if (dto.cadenceId) await this.startCadence(ownerId, p, dto.cadenceId, dto);
    if (dto.funded) await this.syncCurrentBalance(ownerId, p.id, dto.funded);
    if (p.stage === Stage.FORMS_SENT) await this.startChecklist(ownerId, p);
    return serializeProspect(
      await this.prisma.prospect.findUniqueOrThrow({ where: { id: p.id } }),
    );
  }

  async update(ownerId: string, id: string, dto: UpdateProspectDto) {
    const current = await this.owned(ownerId, id);
    if (dto.referredById) {
      if (dto.referredById === id)
        throw new BadRequestException({
          statusCode: 400,
          message: 'A prospect can’t refer themselves',
          errors: { referredById: 'Pick someone else' },
        });
      await this.owned(ownerId, dto.referredById);
    }
    const data: Prisma.ProspectUncheckedUpdateInput = toData(dto);
    const stageChanged = !!dto.stage && dto.stage !== current.stage;
    if (stageChanged) data.stageChangedAt = new Date();
    if (dto.consentMethod !== undefined)
      data.consentAt = dto.consentMethod
        ? current.consentMethod === dto.consentMethod
          ? undefined
          : new Date()
        : null;

    const [p] = await this.prisma.$transaction([
      this.prisma.prospect.update({ where: { id }, data }),
      ...(stageChanged
        ? [
            this.prisma.activity.create({
              data: {
                prospectId: id,
                userId: ownerId,
                type: ActivityType.STAGE_CHANGE,
                fromStage: current.stage,
                toStage: dto.stage,
              },
            }),
          ]
        : []),
    ]);

    if (stageChanged && dto.stage === Stage.FORMS_SENT)
      await this.startChecklist(ownerId, p);

    if (dto.cadenceId !== undefined && dto.cadenceId !== current.cadenceId) {
      if (dto.cadenceId)
        await this.startCadence(ownerId, p, dto.cadenceId, dto);
      else
        await this.prisma.prospect.update({
          where: { id },
          data: { cadenceStep: null, cadenceStart: null },
        });
    }
    // Typing a funded amount on the card is this month's balance.
    if (
      dto.funded !== undefined &&
      Number(current.funded ?? 0) !== (dto.funded ?? 0)
    )
      await this.syncCurrentBalance(ownerId, id, dto.funded);

    return serializeProspect(
      await this.prisma.prospect.findUniqueOrThrow({ where: { id } }),
    );
  }

  async remove(ownerId: string, id: string, client: ClientInfo) {
    const p = await this.owned(ownerId, id);
    await this.prisma.prospect.delete({ where: { id } });
    await this.audit.record(ownerId, 'prospect.deleted', client, p.name);
  }

  /**
   * Record a touch. A first contact moves the prospect out of IDENTIFIED. The next
   * follow-up comes from the request, else the cadence's next step, else the tier gap.
   */
  async logActivity(
    ownerId: string,
    id: string,
    dto: LogActivityDto,
    /** When it happened, for contacts logged after the fact (debriefs). */
    occurredAt?: Date,
  ) {
    const current = await this.prisma.prospect.findFirst({
      where: { id, ownerId },
      include: { cadence: true },
    });
    if (!current) throw new NotFoundException('Prospect not found');
    // Sent again after a dropped connection: it's already saved.
    if (
      dto.clientId &&
      (await this.prisma.activity.count({ where: { id: dto.clientId } }))
    )
      return this.get(ownerId, id);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { timezone: true },
    });
    const today = todayIn(user.timezone);

    const data: Prisma.ProspectUncheckedUpdateInput = {
      lastContactAt: occurredAt ?? new Date(),
    };
    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.activity.create({
        data: {
          id: dto.clientId,
          prospectId: id,
          userId: ownerId,
          type: dto.type,
          outcome: dto.outcome,
          note: dto.note?.trim() || null,
          occurredAt,
        },
      }),
    ];

    // A call nobody answered isn't a contact yet.
    const reached = !['NO_ANSWER', 'WRONG_NUMBER'].includes(dto.outcome ?? '');
    if (current.stage === Stage.IDENTIFIED && reached) {
      data.stage = Stage.CONTACTED;
      data.stageChangedAt = new Date();
      ops.push(
        this.prisma.activity.create({
          data: {
            prospectId: id,
            userId: ownerId,
            type: ActivityType.STAGE_CHANGE,
            fromStage: Stage.IDENTIFIED,
            toStage: Stage.CONTACTED,
          },
        }),
      );
    }

    // Advance the follow-up plan when this touch completes its current step.
    let planned: { nextDate: string; nextAction: string } | null = null;
    if (current.cadence && current.cadenceStep !== null && reached) {
      const steps = parseSteps(current.cadence.steps);
      const next = current.cadenceStep + 1;
      const start = current.cadenceStart?.toISOString().slice(0, 10) ?? today;
      planned = stepDue(steps, next, start, today);
      if (planned) data.cadenceStep = next;
      else {
        // Plan finished.
        data.cadenceId = null;
        data.cadenceStep = null;
        data.cadenceStart = null;
      }
    }

    if (dto.nextAction !== undefined) {
      data.nextAction = dto.nextAction.trim() || null;
    } else if (planned) {
      data.nextAction = planned.nextAction;
    }
    const next = current.nextDate?.toISOString().slice(0, 10);
    // A new date drops the old time unless one comes with it.
    if (dto.nextDate) {
      data.nextDate = toDate(dto.nextDate);
      data.nextTime = dto.nextTime ?? null;
    } else if (planned) {
      data.nextDate = toDate(planned.nextDate);
      data.nextTime = null;
    } else if (!next || next <= today) {
      // Customers who've funded are looked after less often than prospects.
      const gap =
        current.stage === Stage.FUNDED
          ? careDays(current.tier)
          : current.tier
            ? FOLLOW_UP_DAYS[current.tier]
            : 7;
      data.nextDate = toDate(addDays(today, gap));
      data.nextTime = null;
    }

    await this.prisma.$transaction([
      ...ops,
      this.prisma.prospect.update({ where: { id }, data }),
    ]);
    return this.get(ownerId, id);
  }

  async deleteActivity(
    ownerId: string,
    prospectId: string,
    activityId: string,
  ) {
    await this.owned(ownerId, prospectId);
    const { count } = await this.prisma.activity.deleteMany({
      where: { id: activityId, prospectId },
    });
    if (!count) throw new NotFoundException('Activity not found');
  }

  /**
   * Sends an email to the prospect from the platform address, under the user's
   * name, with replies going to the user's own inbox. Logs it as an EMAIL contact.
   */
  async sendEmail(ownerId: string, id: string, dto: SendEmailDto) {
    const prospect = await this.owned(ownerId, id);
    if (!prospect.email)
      throw new BadRequestException(
        'This prospect has no email address. Add one in their details first.',
      );
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
    });
    const signature = [
      user.name,
      user.jobTitle,
      'ProvidusUnity Bank',
      user.phone,
    ]
      .filter(Boolean)
      .join('\n');
    const text = `${dto.body.trim()}\n\n--\n${signature}`;

    await this.mail.send({
      to: prospect.email,
      subject: dto.subject.trim(),
      text,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2d35">${textToHtml(text)}</div>`,
      fromName: user.name,
      replyTo: user.email,
    });

    return this.logActivity(ownerId, id, {
      type: ActivityType.EMAIL,
      note: `Emailed: ${dto.subject.trim()}`,
    });
  }

  async sendSms(ownerId: string, id: string, dto: SendSmsDto) {
    const prospect = await this.owned(ownerId, id);
    if (!prospect.phone)
      throw new BadRequestException(
        'This prospect has no phone number. Add one in their details first.',
      );
    await this.sms.send(prospect.phone, dto.body.trim());
    const preview = dto.body.trim().replace(/\s+/g, ' ');
    return this.logActivity(ownerId, id, {
      type: ActivityType.SMS,
      note: `Texted: ${preview.length > 120 ? `${preview.slice(0, 117)}…` : preview}`,
    });
  }

  // ------------------------------------------------------------ balances

  async setBalance(ownerId: string, id: string, dto: BalanceDto) {
    await this.owned(ownerId, id);
    await this.prisma.balance.upsert({
      where: {
        prospectId_month: { prospectId: id, month: monthDate(dto.month) },
      },
      create: {
        prospectId: id,
        userId: ownerId,
        month: monthDate(dto.month),
        amount: BigInt(dto.amount),
      },
      update: { amount: BigInt(dto.amount) },
    });
    await this.afterBalanceChange(ownerId, id);
    return this.get(ownerId, id);
  }

  async removeBalance(ownerId: string, id: string, month: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      throw new BadRequestException('Pick a valid month');
    await this.owned(ownerId, id);
    await this.prisma.balance.deleteMany({
      where: { prospectId: id, month: monthDate(month) },
    });
    await this.afterBalanceChange(ownerId, id);
    return this.get(ownerId, id);
  }

  /**
   * The monthly update sheet: every customer (account opened or funded, or with any
   * balance on record), their balance for the month and their latest one before it.
   */
  async balanceSheet(ownerId: string, month?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { timezone: true },
    });
    const ym = month ?? monthOf(todayIn(user.timezone));
    const rows = await this.prisma.prospect.findMany({
      where: {
        ownerId,
        OR: [
          { stage: { in: [Stage.ACCOUNT_OPENED, Stage.FUNDED] } },
          { balances: { some: {} } },
        ],
      },
      include: {
        balances: {
          where: { month: { lte: monthDate(ym) } },
          orderBy: { month: 'desc' },
          take: 2,
        },
      },
      orderBy: { name: 'asc' },
    });
    return {
      month: ym,
      rows: rows.map((p) => {
        const thisMonth = p.balances.find(
          (b) => monthOf(b.month.toISOString()) === ym,
        );
        const before = p.balances.find(
          (b) => monthOf(b.month.toISOString()) < ym,
        );
        return {
          id: p.id,
          name: p.name,
          company: p.company,
          tier: p.tier,
          stage: p.stage,
          amount: thisMonth ? Number(thisMonth.amount) : null,
          previous: before
            ? {
                month: monthOf(before.month.toISOString()),
                amount: Number(before.amount),
              }
            : null,
        };
      }),
    };
  }

  async saveBalanceSheet(ownerId: string, dto: BalanceBatchDto) {
    const ids = [...new Set(dto.rows.map((r) => r.prospectId))];
    const owned = await this.prisma.prospect.count({
      where: { ownerId, id: { in: ids } },
    });
    if (owned !== ids.length)
      throw new NotFoundException(
        'Some of those customers no longer exist. Refresh and try again.',
      );
    const month = monthDate(dto.month);
    await this.prisma.$transaction(
      dto.rows.map((r) =>
        r.amount === null
          ? this.prisma.balance.deleteMany({
              where: { prospectId: r.prospectId, month },
            })
          : this.prisma.balance.upsert({
              where: {
                prospectId_month: { prospectId: r.prospectId, month },
              },
              create: {
                prospectId: r.prospectId,
                userId: ownerId,
                month,
                amount: BigInt(r.amount),
              },
              update: { amount: BigInt(r.amount) },
            }),
      ),
    );
    for (const id of ids) await this.afterBalanceChange(ownerId, id);
    return this.balanceSheet(ownerId, dto.month);
  }

  /** A funded amount typed on the card becomes (or clears) this month's balance. */
  private async syncCurrentBalance(
    ownerId: string,
    id: string,
    amount: number | null,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { timezone: true },
    });
    const month = monthDate(monthOf(todayIn(user.timezone)));
    if (!amount)
      await this.prisma.balance.deleteMany({
        where: { prospectId: id, month },
      });
    else
      await this.prisma.balance.upsert({
        where: { prospectId_month: { prospectId: id, month } },
        create: {
          prospectId: id,
          userId: ownerId,
          month,
          amount: BigInt(amount),
        },
        update: { amount: BigInt(amount) },
      });
    await this.afterBalanceChange(ownerId, id);
  }

  /**
   * Mirrors the latest balance to `funded`, and moves a prospect with money in the
   * account to FUNDED so the pipeline matches reality.
   */
  private async afterBalanceChange(ownerId: string, id: string) {
    const [p, latest] = await Promise.all([
      this.prisma.prospect.findUniqueOrThrow({ where: { id } }),
      this.prisma.balance.findFirst({
        where: { prospectId: id },
        orderBy: { month: 'desc' },
      }),
    ]);
    const funded = latest?.amount ?? null;
    const promote =
      !!funded &&
      funded > 0n &&
      p.stage !== Stage.FUNDED &&
      p.stage !== Stage.DECLINED;
    await this.prisma.$transaction([
      this.prisma.prospect.update({
        where: { id },
        data: {
          funded,
          ...(promote
            ? { stage: Stage.FUNDED, stageChangedAt: new Date() }
            : {}),
        },
      }),
      ...(promote
        ? [
            this.prisma.activity.create({
              data: {
                prospectId: id,
                userId: ownerId,
                type: ActivityType.STAGE_CHANGE,
                fromStage: p.stage,
                toStage: Stage.FUNDED,
              },
            }),
          ]
        : []),
    ]);
    await this.flagBalanceDrop(ownerId, p).catch(() => {});
  }

  /** A sharp fall in a customer's balance becomes a to-do to call them. */
  private async flagBalanceDrop(ownerId: string, p: Prospect) {
    const rows = await this.prisma.balance.findMany({
      where: { prospectId: p.id },
      orderBy: { month: 'desc' },
      take: 2,
    });
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { timezone: true },
    });
    const today = todayIn(user.timezone);
    const lastMonth = monthOf(addDays(`${monthOf(today)}-01`, -1));
    const [drop] = balanceDrops(
      rows.map((r) => ({
        prospectId: r.prospectId,
        month: monthOf(r.month.toISOString()),
        amount: Number(r.amount),
      })),
      lastMonth,
    );
    if (!drop) return;
    const source = `balance-drop:${p.id}:${drop.month}`;
    if (await this.prisma.task.count({ where: { ownerId, source } })) return;
    const m = Math.round(drop.drop / 100_000) / 10;
    await this.prisma.task.create({
      data: {
        ownerId,
        prospectId: p.id,
        source,
        title: `Call ${p.name}: balance down ₦${m}m. Find out why and how to win it back`,
        dueDate: toDate(today),
      },
    });
  }

  /** Marks that they've been asked for a referral (or clears it). */
  async setReferralAsked(ownerId: string, id: string, asked: boolean) {
    await this.owned(ownerId, id);
    return serializeProspect(
      await this.prisma.prospect.update({
        where: { id },
        data: { referralAskedAt: asked ? new Date() : null },
      }),
    );
  }

  // ------------------------------------------------------------ import / export

  /**
   * Creates prospects from spreadsheet rows, skipping anyone who already exists
   * (same phone, same email, or same name) or appears twice in the file.
   */
  async import(ownerId: string, rows: CreateProspectDto[], client: ClientInfo) {
    const existing = await this.prisma.prospect.findMany({
      where: { ownerId },
      select: { name: true, phone: true, email: true },
    });
    const phones = new Set(
      existing.map((p) => phoneKey(p.phone)).filter(Boolean),
    );
    const emails = new Set(
      existing.map((p) => p.email?.toLowerCase()).filter(Boolean),
    );
    const names = new Set(existing.map((p) => p.name.trim().toLowerCase()));

    const create: Prisma.ProspectCreateManyInput[] = [];
    const skipped: { row: number; name: string; reason: string }[] = [];
    rows.forEach((r, i) => {
      const name = r.name.trim();
      const phone = phoneKey(r.phone);
      const email = r.email?.trim().toLowerCase();
      const reason =
        phone && phones.has(phone)
          ? 'Same phone number as an existing prospect'
          : email && emails.has(email)
            ? 'Same email as an existing prospect'
            : names.has(name.toLowerCase())
              ? 'Same name as an existing prospect'
              : null;
      if (reason) {
        skipped.push({ row: i + 1, name, reason });
        return;
      }
      if (phone) phones.add(phone);
      if (email) emails.add(email);
      names.add(name.toLowerCase());
      const data = toData({
        ...r,
        cadenceId: undefined,
        referredById: undefined,
      });
      create.push({
        ...data,
        name,
        ownerId,
        stage: data.stage ?? Stage.IDENTIFIED,
        wantsProducts: data.wantsProducts ?? [],
        holdsProducts: data.holdsProducts ?? [],
        consentAt: r.consentMethod ? new Date() : undefined,
        latitude: data.latitude ?? undefined,
        longitude: data.longitude ?? undefined,
      });
    });
    if (create.length) await this.prisma.prospect.createMany({ data: create });
    await this.audit.record(
      ownerId,
      'prospects.imported',
      client,
      `${create.length} added, ${skipped.length} skipped`,
    );
    return { created: create.length, skipped };
  }

  async exportCsv(ownerId: string, client: ClientInfo) {
    const rows = await this.prisma.prospect.findMany({
      where: { ownerId },
      include: { referredBy: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
    await this.audit.record(
      ownerId,
      'prospects.exported',
      client,
      `${rows.length} prospects`,
    );
    const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
    return toCsv(
      [
        'Name',
        'Company',
        'Group',
        'Phone',
        'Email',
        'Tier',
        'Stage',
        'Deposit potential (NGN)',
        'Current balance (NGN)',
        'Source',
        'Referred by',
        'Interested in',
        'Already holds',
        'Area',
        'Address',
        'Birthday (MM-DD)',
        'Next action',
        'Next follow-up',
        'Last contact',
        'Consent',
        'Outcome reason',
        'Notes',
        'Added',
      ],
      rows.map((p) => [
        p.name,
        p.company,
        p.group,
        p.phone,
        p.email,
        p.tier,
        p.stage,
        p.potential?.toString(),
        p.funded?.toString(),
        p.source,
        p.referredBy?.name,
        p.wantsProducts.join('; '),
        p.holdsProducts.join('; '),
        p.area,
        p.address,
        p.birthday,
        p.nextAction,
        ymd(p.nextDate),
        ymd(p.lastContactAt),
        p.consentMethod ? `${p.consentMethod} ${ymd(p.consentAt)}` : '',
        p.outcomeReason,
        p.notes,
        ymd(p.createdAt),
      ]),
    );
  }

  // ------------------------------------------------------------ helpers

  private async startCadence(
    ownerId: string,
    p: Prospect,
    cadenceId: string,
    dto: UpdateProspectDto,
  ) {
    const cadence = await this.cadences.owned(ownerId, cadenceId);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { timezone: true },
    });
    const today = todayIn(user.timezone);
    const first = stepDue(cadence.steps, 0, today, today);
    await this.prisma.prospect.update({
      where: { id: p.id },
      data: {
        cadenceId,
        cadenceStep: 0,
        cadenceStart: toDate(today),
        // An explicit next step on the same save wins over the plan's first step.
        nextDate: dto.nextDate
          ? undefined
          : first
            ? toDate(first.nextDate)
            : undefined,
        nextAction: dto.nextAction ? undefined : first?.nextAction,
      },
    });
  }

  private async owned(ownerId: string, id: string) {
    const p = await this.prisma.prospect.findFirst({ where: { id, ownerId } });
    if (!p) throw new NotFoundException('Prospect not found');
    return p;
  }
}

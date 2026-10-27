import { Injectable, NotFoundException } from '@nestjs/common';
import { ActivityType, Prisma, Stage, Tier } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, todayIn, toDate } from '../common/dates';
import {
  CreateProspectDto,
  ListProspectsQuery,
  LogActivityDto,
  UpdateProspectDto,
} from './prospect.dto';
import { serializeProspect } from './prospect.serializer';

/** Default follow-up gap after a contact, by tier. Unrated prospects get a week. */
export const FOLLOW_UP_DAYS: Record<Tier, number> = { A: 7, B: 14, C: 30 };

const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2 };

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
    notes: blank(dto.notes),
  };
}

@Injectable()
export class ProspectsService {
  constructor(private prisma: PrismaService) {}

  async list(ownerId: string, query: ListProspectsQuery) {
    const where: Prisma.ProspectWhereInput = { ownerId };
    if (query.stage) where.stage = query.stage;
    if (query.tier)
      where.tier = query.tier === 'NONE' ? null : (query.tier as Tier);
    if (query.group) where.group = query.group;
    const q = query.q?.trim();
    if (q) {
      where.OR = (
        ['name', 'company', 'notes', 'group', 'nextAction'] as const
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

  async groups(ownerId: string) {
    const rows = await this.prisma.prospect.findMany({
      where: { ownerId, group: { not: null } },
      distinct: ['group'],
      select: { group: true },
      orderBy: { group: 'asc' },
    });
    return rows.map((r) => r.group);
  }

  async get(ownerId: string, id: string) {
    const p = await this.prisma.prospect.findFirst({
      where: { id, ownerId },
      include: { activities: { orderBy: { occurredAt: 'desc' }, take: 100 } },
    });
    if (!p) throw new NotFoundException('Prospect not found');
    const { activities, ...rest } = p;
    return { ...serializeProspect(rest), activities };
  }

  async create(ownerId: string, dto: CreateProspectDto) {
    const p = await this.prisma.prospect.create({
      data: { ...toData(dto), name: dto.name.trim(), ownerId },
    });
    return serializeProspect(p);
  }

  async update(ownerId: string, id: string, dto: UpdateProspectDto) {
    const current = await this.owned(ownerId, id);
    const data = toData(dto);
    const stageChanged = data.stage && data.stage !== current.stage;

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
                toStage: data.stage,
              },
            }),
          ]
        : []),
    ]);
    return serializeProspect(p);
  }

  async remove(ownerId: string, id: string) {
    await this.owned(ownerId, id);
    await this.prisma.prospect.delete({ where: { id } });
  }

  /**
   * Record a touch. A first contact moves the prospect out of IDENTIFIED, and if no
   * future follow-up is set, one is scheduled from the tier's cadence.
   */
  async logActivity(ownerId: string, id: string, dto: LogActivityDto) {
    const current = await this.owned(ownerId, id);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { timezone: true },
    });
    const today = todayIn(user.timezone);

    const data: Prisma.ProspectUpdateInput = { lastContactAt: new Date() };
    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.activity.create({
        data: {
          prospectId: id,
          userId: ownerId,
          type: dto.type,
          note: dto.note?.trim() || null,
        },
      }),
    ];

    if (current.stage === Stage.IDENTIFIED) {
      data.stage = Stage.CONTACTED;
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

    if (dto.nextAction !== undefined) {
      data.nextAction = dto.nextAction.trim() || null;
    }
    const next = current.nextDate?.toISOString().slice(0, 10);
    if (dto.nextDate) {
      data.nextDate = toDate(dto.nextDate);
    } else if (!next || next <= today) {
      const gap = current.tier ? FOLLOW_UP_DAYS[current.tier] : 7;
      data.nextDate = toDate(addDays(today, gap));
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

  private async owned(ownerId: string, id: string) {
    const p = await this.prisma.prospect.findFirst({ where: { id, ownerId } });
    if (!p) throw new NotFoundException('Prospect not found');
    return p;
  }
}

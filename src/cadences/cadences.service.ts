import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_CADENCES, parseSteps } from './cadences';
import { CadenceDto, StepDto, UpdateCadenceDto } from './cadence.dto';

/** Steps are kept in day order so "next step" is always the next index. */
const sorted = (steps: StepDto[]) =>
  [...steps]
    .sort((a, b) => a.day - b.day)
    .map((s) => ({ day: s.day, type: s.type, action: s.action.trim() }));

@Injectable()
export class CadencesService {
  constructor(private prisma: PrismaService) {}

  async list(ownerId: string) {
    await this.seedOnce(ownerId);
    const rows = await this.prisma.cadence.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { prospects: true } } },
    });
    return rows.map(({ _count, ...c }) => ({
      ...c,
      steps: parseSteps(c.steps),
      prospectCount: _count.prospects,
    }));
  }

  async create(ownerId: string, dto: CadenceDto) {
    const c = await this.prisma.cadence.create({
      data: {
        ownerId,
        name: dto.name.trim(),
        steps: sorted(dto.steps),
      },
    });
    return { ...c, steps: parseSteps(c.steps), prospectCount: 0 };
  }

  async update(ownerId: string, id: string, dto: UpdateCadenceDto) {
    await this.owned(ownerId, id);
    const c = await this.prisma.cadence.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        steps: dto.steps
          ? (sorted(dto.steps) as unknown as Prisma.InputJsonValue)
          : undefined,
      },
    });
    return { ...c, steps: parseSteps(c.steps) };
  }

  async remove(ownerId: string, id: string) {
    await this.owned(ownerId, id);
    // Prospects on the plan keep their current next step and simply leave it.
    await this.prisma.$transaction([
      this.prisma.prospect.updateMany({
        where: { cadenceId: id },
        data: { cadenceId: null, cadenceStep: null, cadenceStart: null },
      }),
      this.prisma.cadence.delete({ where: { id } }),
    ]);
  }

  async owned(ownerId: string, id: string) {
    const c = await this.prisma.cadence.findFirst({ where: { id, ownerId } });
    if (!c) throw new NotFoundException('That follow-up plan no longer exists');
    return { ...c, steps: parseSteps(c.steps) };
  }

  private async seedOnce(ownerId: string) {
    const { count } = await this.prisma.user.updateMany({
      where: { id: ownerId, cadencesSeeded: false },
      data: { cadencesSeeded: true },
    });
    if (!count) return;
    await this.prisma.cadence.createMany({
      data: DEFAULT_CADENCES.map((c) => ({
        ownerId,
        name: c.name,
        steps: c.steps as unknown as Prisma.InputJsonValue,
      })),
    });
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toDate } from '../common/dates';
import { nextOccurrence } from './repeat';
import { ChecklistKind, CHECKLISTS } from './checklists';
import { CreateTaskDto, ListTasksQuery, UpdateTaskDto } from './task.dto';

type TaskRow = Task & {
  prospect: { id: string; name: string; company: string | null } | null;
};

const withProspect = {
  prospect: { select: { id: true, name: true, company: true } },
} satisfies Prisma.TaskInclude;

export const serializeTask = (t: TaskRow) => ({
  id: t.id,
  title: t.title,
  dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
  dueTime: t.dueTime,
  repeat: t.repeat,
  checklist: t.checklist,
  prospect: t.prospect,
  doneAt: t.doneAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
});

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  async list(ownerId: string, q: ListTasksQuery) {
    const done = q.status === 'done';
    const rows = await this.prisma.task.findMany({
      where: {
        ownerId,
        prospectId: q.prospectId,
        doneAt: done ? { not: null } : null,
      },
      include: withProspect,
      orderBy: done
        ? [{ doneAt: 'desc' }]
        : [
            { dueDate: { sort: 'asc', nulls: 'last' } },
            { dueTime: { sort: 'asc', nulls: 'last' } },
            { position: 'asc' },
            { createdAt: 'asc' },
          ],
      take: done ? 100 : 500,
    });
    return rows.map(serializeTask);
  }

  private async ownedProspect(ownerId: string, id: string) {
    const p = await this.prisma.prospect.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!p)
      throw new NotFoundException(
        'We couldn’t find that prospect. It may have been deleted.',
      );
  }

  private async owned(ownerId: string, id: string) {
    const t = await this.prisma.task.findFirst({ where: { id, ownerId } });
    if (!t)
      throw new NotFoundException(
        'We couldn’t find that to-do. It may have been deleted.',
      );
    return t;
  }

  async create(ownerId: string, dto: CreateTaskDto) {
    if (dto.prospectId) await this.ownedProspect(ownerId, dto.prospectId);
    if (dto.id) {
      const sent = await this.prisma.task.findFirst({
        where: { id: dto.id, ownerId },
        include: withProspect,
      });
      if (sent) return serializeTask(sent);
    }
    const t = await this.prisma.task.create({
      data: {
        id: dto.id,
        source: dto.source,
        ownerId,
        title: dto.title.trim(),
        prospectId: dto.prospectId ?? null,
        dueDate: dto.dueDate ? toDate(dto.dueDate) : null,
        dueTime: dto.dueDate ? (dto.dueTime ?? null) : null,
        repeat: dto.dueDate ? (dto.repeat ?? null) : null,
        doneAt: dto.done ? new Date() : null,
      },
      include: withProspect,
    });
    return serializeTask(t);
  }

  async update(ownerId: string, id: string, dto: UpdateTaskDto) {
    const current = await this.owned(ownerId, id);
    if (dto.prospectId) await this.ownedProspect(ownerId, dto.prospectId);
    const data: Prisma.TaskUncheckedUpdateInput = {
      title: dto.title?.trim(),
      prospectId: dto.prospectId,
      repeat: dto.repeat,
    };
    if (dto.dueDate !== undefined) {
      data.dueDate = dto.dueDate ? toDate(dto.dueDate) : null;
      if (!dto.dueDate) data.dueTime = data.repeat = null;
    }
    if (dto.dueTime !== undefined && dto.dueDate !== null)
      data.dueTime = dto.dueTime;
    // A new time means a new reminder.
    if (dto.dueDate !== undefined || dto.dueTime !== undefined)
      data.remindedFor = null;

    let next: TaskRow | null = null;
    if (dto.done !== undefined && dto.done !== !!current.doneAt) {
      data.doneAt = dto.done ? new Date() : null;
      // Ticking a repeating task schedules the next one.
      const repeat = dto.repeat === undefined ? current.repeat : dto.repeat;
      const due =
        dto.dueDate === undefined
          ? current.dueDate?.toISOString().slice(0, 10)
          : dto.dueDate;
      if (dto.done && repeat && due) {
        data.repeat = null;
        next = await this.prisma.task.create({
          data: {
            ownerId,
            prospectId: current.prospectId,
            title: (dto.title ?? current.title).trim(),
            dueDate: toDate(nextOccurrence(due, repeat)),
            dueTime: dto.dueTime === undefined ? current.dueTime : dto.dueTime,
            repeat,
          },
          include: withProspect,
        });
      }
    }
    const t = await this.prisma.task.update({
      where: { id },
      data,
      include: withProspect,
    });
    return { ...serializeTask(t), next: next && serializeTask(next) };
  }

  async remove(ownerId: string, id: string) {
    await this.owned(ownerId, id);
    await this.prisma.task.delete({ where: { id } });
  }

  /**
   * Adds the account-opening document checklist to a prospect. Replaces an
   * earlier one of the other kind if none of it has been ticked yet.
   */
  async addChecklist(ownerId: string, prospectId: string, kind: ChecklistKind) {
    await this.ownedProspect(ownerId, prospectId);
    const existing = await this.prisma.task.findMany({
      where: { prospectId, checklist: { not: null } },
      select: { id: true, checklist: true, doneAt: true },
    });
    if (existing.some((t) => t.checklist === kind))
      return this.forProspect(prospectId);
    if (existing.length && existing.every((t) => !t.doneAt))
      await this.prisma.task.deleteMany({
        where: { id: { in: existing.map((t) => t.id) } },
      });
    const items: readonly string[] = CHECKLISTS[kind];
    await this.prisma.task.createMany({
      data: items.map((title, position) => ({
        ownerId,
        prospectId,
        title,
        checklist: kind,
        position,
      })),
    });
    return this.forProspect(prospectId);
  }

  /** On "Forms sent", start the checklist unless the prospect already has one. */
  async checklistOnFormsSent(
    ownerId: string,
    prospectId: string,
    business: boolean,
  ) {
    const has = await this.prisma.task.count({
      where: { prospectId, checklist: { not: null } },
    });
    if (!has)
      await this.addChecklist(
        ownerId,
        prospectId,
        business ? 'BUSINESS' : 'INDIVIDUAL',
      );
  }

  private async forProspect(prospectId: string) {
    const rows = await this.prisma.task.findMany({
      where: { prospectId },
      include: withProspect,
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(serializeTask);
  }

  /** Last week's ticked tasks for the manager report. */
  async doneBetween(ownerId: string, from: Date, to: Date) {
    const rows = await this.prisma.task.findMany({
      where: { ownerId, doneAt: { gte: from, lt: to } },
      include: withProspect,
      orderBy: { doneAt: 'asc' },
    });
    return rows.map(serializeTask);
  }
}

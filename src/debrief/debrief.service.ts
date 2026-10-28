import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Debrief, DebriefStatus, Prisma, Product, Stage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiService, DebriefReadingItem } from '../ai/ai.service';
import { ProspectsService } from '../prospects/prospects.service';
import { HHMM, UpdateProspectDto } from '../prospects/prospect.dto';
import { addDays, startOfDay, todayIn } from '../common/dates';
import { TranscribeService } from './transcribe.service';
import {
  ApplyDebriefDto,
  CreateDebriefDto,
  ProcessDebriefDto,
} from './debrief.dto';

const PART_MAX = 3 * 1024 * 1024;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** A job that hasn't moved in this long died with a server restart. */
const STUCK_MS = 6 * 60_000;
const KEEP_DAYS = 14;

/** What the review screen shows for one person, before you confirm it. */
export interface Suggestion {
  key: string;
  mention: string;
  match: 'EXISTING' | 'NEW' | 'UNSURE';
  prospectId: string | null;
  candidates: { id: string; name: string; company: string | null }[];
  newProspect: { name: string; company: string; phone: string; area: string };
  contact: {
    type: string;
    date: string;
    outcome: string | null;
    note: string;
  } | null;
  note: string;
  stage: Stage | null;
  outcomeReason: string;
  potential: number | null;
  funded: number | null;
  tier: 'A' | 'B' | 'C' | null;
  wantsProducts: Product[];
  holdsProducts: Product[];
  referredById: string | null;
  nextAction: string;
  nextDate: string | null;
  nextTime: string | null;
  check: string[];
}

export interface DebriefResult {
  items: Suggestion[];
  other: string[];
}

const message = (e: unknown) =>
  e instanceof HttpException
    ? (() => {
        const r = e.getResponse();
        return typeof r === 'string'
          ? r
          : ((r as { message?: string | string[] }).message?.toString() ??
              e.message);
      })()
    : 'Something went wrong. Please try again.';

/**
 * End-of-day debriefs: audio arrives in parts (so no proxy or host body limit
 * cuts it short), is transcribed, read by the assistant into suggested updates,
 * reviewed by the user, then applied through the normal prospect logic.
 * Processing runs in the background and the app polls, so a long recording
 * can't hit a request timeout.
 */
@Injectable()
export class DebriefService {
  private log = new Logger('Debrief');
  /** Audio parts waiting for "process"; held in memory, never written to disk. */
  private uploads = new Map<string, { parts: Buffer[]; at: number }>();

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private transcriber: TranscribeService,
    private prospects: ProspectsService,
  ) {}

  status() {
    return {
      ai: this.ai.configured,
      voice: this.transcriber.configured,
      provider: this.transcriber.provider,
    };
  }

  private view(d: Debrief) {
    return {
      id: d.id,
      status: d.status,
      step: d.step,
      transcript: d.transcript,
      result: d.result as DebriefResult | null,
      applied: d.applied,
      error: d.error,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  private async owned(userId: string, id: string) {
    const d = await this.prisma.debrief.findFirst({ where: { id, userId } });
    if (!d)
      throw new NotFoundException(
        'We couldn’t find that debrief. It may have expired.',
      );
    return d;
  }

  async create(userId: string, dto: CreateDebriefDto) {
    if (!this.ai.configured)
      throw new ServiceUnavailableException(
        'The AI assistant isn’t switched on for this server yet, so debriefs can’t be read.',
      );
    const text = dto.text?.trim();
    if (!text && !this.transcriber.configured)
      throw new ServiceUnavailableException(
        'Voice debriefs aren’t switched on for this server yet. You can type your debrief instead.',
      );
    const d = await this.prisma.debrief.create({
      data: text
        ? {
            userId,
            status: DebriefStatus.PROCESSING,
            step: 'READING',
            transcript: text,
          }
        : { userId },
    });
    if (text) void this.read(d.id, userId, text);
    return this.view(d);
  }

  async putPart(userId: string, id: string, index: number, body: unknown) {
    const d = await this.owned(userId, id);
    if (d.status !== DebriefStatus.UPLOADING)
      throw new ConflictException('This recording has already been sent.');
    if (!Buffer.isBuffer(body) || !body.length)
      throw new BadRequestException(
        'The recording didn’t arrive. Check your connection and try again.',
      );
    if (body.length > PART_MAX)
      throw new PayloadTooLargeException('That part is too large.');
    const upload = this.uploads.get(id) ?? { parts: [], at: Date.now() };
    upload.parts[index] = body;
    upload.at = Date.now();
    this.uploads.set(id, upload);
  }

  async process(userId: string, id: string, dto: ProcessDebriefDto) {
    const d = await this.owned(userId, id);
    if (d.status !== DebriefStatus.UPLOADING)
      throw new ConflictException('This recording is already being read.');
    const upload = this.uploads.get(id);
    const parts = upload?.parts.slice(0, dto.parts) ?? [];
    const complete =
      parts.length === dto.parts && parts.every((p) => Buffer.isBuffer(p));
    const audio = complete ? Buffer.concat(parts) : null;
    // Catches a part lost or cut short on the way.
    if (!audio || audio.length !== dto.bytes)
      throw new BadRequestException(
        'Part of the recording didn’t arrive. Sending it again…',
      );
    this.uploads.delete(id);
    const started = await this.prisma.debrief.update({
      where: { id },
      data: { status: DebriefStatus.PROCESSING, step: 'TRANSCRIBING' },
    });
    void this.transcribeThenRead(id, userId, audio, dto.mime);
    return this.view(started);
  }

  private async transcribeThenRead(
    id: string,
    userId: string,
    audio: Buffer,
    mime: string,
  ) {
    try {
      const transcript = await this.transcriber.transcribe(
        audio,
        mime,
        await this.hints(userId),
      );
      await this.prisma.debrief.update({
        where: { id },
        data: { transcript, step: 'READING' },
      });
      await this.read(id, userId, transcript);
    } catch (e) {
      await this.fail(id, e);
    }
  }

  /** Names and companies to listen for: the people most likely to come up. */
  private async hints(userId: string) {
    const recent = await this.prisma.prospect.findMany({
      where: { ownerId: userId, stage: { not: Stage.DECLINED } },
      orderBy: [
        { lastContactAt: { sort: 'desc', nulls: 'last' } },
        { nextDate: { sort: 'asc', nulls: 'last' } },
      ],
      take: 60,
      select: { name: true, company: true },
    });
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of recent)
      for (const term of [p.name, p.company])
        if (term && !seen.has(term.toLowerCase())) {
          seen.add(term.toLowerCase());
          out.push(term);
        }
    return out;
  }

  private async read(id: string, userId: string, transcript: string) {
    try {
      const result = await this.suggest(userId, transcript);
      await this.prisma.debrief.update({
        where: { id },
        data: {
          status: DebriefStatus.READY,
          step: null,
          error: null,
          result: result as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      await this.fail(id, e);
    }
  }

  private async fail(id: string, e: unknown) {
    if (!(e instanceof HttpException)) this.log.error((e as Error).message);
    await this.prisma.debrief
      .update({
        where: { id },
        data: { status: DebriefStatus.FAILED, step: null, error: message(e) },
      })
      .catch(() => {});
  }

  /** The assistant's reading, checked and turned into review cards. */
  private async suggest(
    userId: string,
    transcript: string,
  ): Promise<DebriefResult> {
    const { reading, today, byRef } = await this.ai.readDebrief(
      userId,
      transcript,
    );
    const ids = new Set<string>();
    for (const it of reading.items)
      for (const r of [it.ref, it.referredByRef, ...it.alternatives]) {
        const p = byRef.get(r);
        if (p) ids.add(p.id);
      }
    const current = new Map(
      (
        await this.prisma.prospect.findMany({
          where: { ownerId: userId, id: { in: [...ids] } },
          select: { id: true, name: true, company: true, stage: true },
        })
      ).map((p) => [p.id, p]),
    );
    const idOf = (ref: string) => {
      const id = byRef.get(ref)?.id;
      return id && current.has(id) ? id : null;
    };

    const items = reading.items.map((it, i): Suggestion => {
      let prospectId = idOf(it.ref);
      let match = it.match;
      if (match === 'EXISTING' && !prospectId) match = 'UNSURE';
      if (match === 'NEW') prospectId = null;
      const candidates = [
        ...new Set(
          [prospectId, ...it.alternatives.map(idOf)].filter(
            (x): x is string => !!x,
          ),
        ),
      ].map((id) => {
        const p = current.get(id)!;
        return { id, name: p.name, company: p.company };
      });
      // An unsure match is only a suggestion; the user picks.
      if (match === 'UNSURE') prospectId = candidates[0]?.id ?? null;
      const stage = it.stage === 'UNCHANGED' ? null : it.stage;
      return {
        key: `item-${i}`,
        mention: it.mention,
        match,
        prospectId,
        candidates,
        newProspect: {
          name: it.name.trim() || it.mention.trim(),
          company: it.company.trim(),
          phone: it.phone.trim(),
          area: it.area.trim(),
        },
        contact: contactOf(it, today),
        note: it.note.trim(),
        stage:
          stage && prospectId && current.get(prospectId)?.stage === stage
            ? null
            : stage,
        outcomeReason: it.outcomeReason.trim(),
        potential: amount(it.potential),
        funded: amount(it.funded),
        tier: it.tier === 'UNCHANGED' ? null : it.tier,
        wantsProducts: [...new Set(it.wantsProducts)],
        holdsProducts: [...new Set(it.holdsProducts)],
        referredById: idOf(it.referredByRef),
        nextAction: it.nextAction.trim(),
        nextDate: validDate(it.nextDate, today, -1, 400),
        nextTime:
          validDate(it.nextDate, today, -1, 400) && HHMM.test(it.nextTime)
            ? it.nextTime
            : null,
        check: it.check.filter((c) => c.trim()),
      };
    });
    return { items, other: reading.other.filter((o) => o.trim()) };
  }

  async get(userId: string, id: string) {
    let d = await this.owned(userId, id);
    if (
      d.status === DebriefStatus.PROCESSING &&
      Date.now() - d.updatedAt.getTime() > STUCK_MS
    )
      d = await this.prisma.debrief.update({
        where: { id },
        data: {
          status: DebriefStatus.FAILED,
          step: null,
          error: 'This took too long. Please try again.',
        },
      });
    return this.view(d);
  }

  async list(userId: string) {
    const rows = await this.prisma.debrief.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return rows.map((d) => ({
      id: d.id,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
      people: (d.result as DebriefResult | null)?.items.length ?? 0,
      preview: d.transcript?.slice(0, 120) ?? null,
    }));
  }

  /** Read again after the user corrected the transcript. */
  async reread(userId: string, id: string, transcript: string) {
    const d = await this.owned(userId, id);
    if (d.status !== DebriefStatus.READY && d.status !== DebriefStatus.FAILED)
      throw new ConflictException('This debrief can’t be changed now.');
    const text = transcript.trim();
    const updated = await this.prisma.debrief.update({
      where: { id },
      data: {
        status: DebriefStatus.PROCESSING,
        step: 'READING',
        transcript: text,
        error: null,
      },
    });
    void this.read(id, userId, text);
    return this.view(updated);
  }

  async apply(userId: string, id: string, dto: ApplyDebriefDto) {
    const d = await this.owned(userId, id);
    if (d.status === DebriefStatus.APPLIED)
      throw new ConflictException('This debrief has already been saved.');
    if (d.status !== DebriefStatus.READY)
      throw new ConflictException('This debrief isn’t ready to save yet.');
    // Claim it, so a double tap can't apply everything twice.
    const { count } = await this.prisma.debrief.updateMany({
      where: { id, status: DebriefStatus.READY },
      data: { status: DebriefStatus.APPLIED },
    });
    if (!count)
      throw new ConflictException('This debrief has already been saved.');

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    const today = todayIn(user.timezone);
    const results: {
      name: string;
      ok: boolean;
      prospectId?: string;
      created?: boolean;
      error?: string;
    }[] = [];

    for (const item of dto.items) {
      let name = item.newProspect?.name ?? 'Prospect';
      try {
        let prospectId = item.prospectId;
        let created = false;
        if (!prospectId) {
          if (!item.newProspect)
            throw new BadRequestException('Pick who this is first.');
          const p = await this.prospects.create(userId, {
            name: item.newProspect.name,
            company: item.newProspect.company || null,
            phone: item.newProspect.phone || null,
            area: item.newProspect.area || null,
            referredById: item.referredById,
            source: item.referredById ? 'REFERRAL' : undefined,
          });
          prospectId = p.id;
          created = true;
        }
        const current = await this.prisma.prospect.findFirst({
          where: { id: prospectId, ownerId: userId },
          select: {
            name: true,
            notes: true,
            wantsProducts: true,
            holdsProducts: true,
          },
        });
        if (!current)
          throw new NotFoundException('That prospect no longer exists.');
        name = current.name;

        if (item.contact) {
          const date = item.contact.date > today ? today : item.contact.date;
          await this.prospects.logActivity(
            userId,
            prospectId,
            {
              type: item.contact.type,
              outcome: item.contact.outcome,
              note: item.contact.note,
              nextDate: item.nextDate,
              nextTime: item.nextDate ? (item.nextTime ?? null) : undefined,
              nextAction: item.nextAction,
            },
            // Past days are logged at midday; today's at the moment of saving.
            date === today
              ? undefined
              : new Date(
                  startOfDay(date, user.timezone).getTime() + 12 * 3600_000,
                ),
          );
        }

        const update: UpdateProspectDto = {};
        if (item.stage) update.stage = item.stage;
        if (item.outcomeReason) update.outcomeReason = item.outcomeReason;
        if (item.potential !== undefined) update.potential = item.potential;
        if (item.funded !== undefined) update.funded = item.funded;
        if (item.tier) update.tier = item.tier;
        if (item.referredById && !created && item.referredById !== prospectId)
          update.referredById = item.referredById;
        if (item.wantsProducts?.length)
          update.wantsProducts = [
            ...new Set([...current.wantsProducts, ...item.wantsProducts]),
          ];
        if (item.holdsProducts?.length)
          update.holdsProducts = [
            ...new Set([...current.holdsProducts, ...item.holdsProducts]),
          ];
        // Without a contact, the next step and note go straight on the record.
        if (!item.contact) {
          if (item.nextAction !== undefined)
            update.nextAction = item.nextAction || null;
          if (item.nextDate) {
            update.nextDate = item.nextDate;
            update.nextTime = item.nextTime ?? null;
          }
          if (item.note?.trim())
            update.notes = [current.notes, `${today}: ${item.note.trim()}`]
              .filter(Boolean)
              .join('\n')
              .slice(-4000);
        }
        if (Object.keys(update).length)
          await this.prospects.update(userId, prospectId, update);
        results.push({ name, ok: true, prospectId, created });
      } catch (e) {
        results.push({ name, ok: false, error: message(e) });
      }
    }

    const saved = await this.prisma.debrief.update({
      where: { id },
      data: { applied: results },
    });
    return this.view(saved);
  }

  async remove(userId: string, id: string) {
    await this.owned(userId, id);
    this.uploads.delete(id);
    await this.prisma.debrief.delete({ where: { id } });
  }

  /** Transcripts are client talk: keep them only as long as they're useful. */
  @Cron('17 * * * *')
  async cleanUp() {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3600_000);
    await this.prisma.debrief
      .deleteMany({ where: { createdAt: { lt: cutoff } } })
      .catch((e: Error) => this.log.error(e.message));
    for (const [id, u] of this.uploads)
      if (Date.now() - u.at > 30 * 60_000) this.uploads.delete(id);
  }
}

function contactOf(it: DebriefReadingItem, today: string) {
  if (it.contactType === 'NONE') return null;
  return {
    type: it.contactType,
    date: validDate(it.contactDate, today, -30, 0) ?? today,
    outcome: it.outcome === 'UNKNOWN' ? null : it.outcome,
    note: it.note.trim(),
  };
}

/** Whole naira, or null for "not said" and nonsense. */
function amount(n: number) {
  return Number.isInteger(n) && n >= 0 && n <= 1e12 ? n : null;
}

/** A real date within [today + from, today + to] days, else null. */
function validDate(ymd: string, today: string, from: number, to: number) {
  if (!YMD.test(ymd) || isNaN(Date.parse(ymd))) return null;
  return ymd >= addDays(today, from) && ymd <= addDays(today, to) ? ymd : null;
}

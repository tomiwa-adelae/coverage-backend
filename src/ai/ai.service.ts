import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { todayIn } from '../common/dates';

const MODEL = 'claude-opus-5-5';

const STAGE_LABEL: Record<string, string> = {
  IDENTIFIED: 'Identified (not contacted yet)',
  CONTACTED: 'Contacted',
  INTERESTED: 'Interested',
  FORMS_SENT: 'Account opening forms sent',
  FORMS_RECEIVED: 'Forms received',
  ACCOUNT_OPENED: 'Account opened, not funded yet',
  FUNDED: 'Funded customer',
  DECLINED: 'Declined',
};

const SYSTEM = `You help a relationship manager (RM) at ProvidusUnity Bank, a Nigerian commercial bank, win and grow deposit relationships. The RM's goal is to grow their customers' deposit balances.

Work only from the prospect record you are given. Never invent facts, figures, promises, rates or product terms that are not in the record; if something useful is unknown, say what to find out instead. Write in clear, warm Nigerian business English. Amounts are in naira; write them like ₦25,000,000.`;

const BriefSchema = z.object({
  summary: z
    .string()
    .describe('Two or three sentences: who they are and where things stand.'),
  promised: z
    .array(z.string())
    .describe('Commitments either side made in past contacts. Empty if none.'),
  pitch: z
    .array(z.string())
    .describe('Products or angles to raise next, each with a short reason.'),
  questions: z
    .array(z.string())
    .describe('Questions to ask to move them forward or fill gaps.'),
  watchOut: z
    .array(z.string())
    .describe(
      'Objections, risks or sensitivities from the history. Empty if none.',
    ),
});

const DraftSchema = z.object({
  subject: z
    .string()
    .describe('Email subject line; empty string for WhatsApp or SMS.'),
  body: z.string().describe('The message, ready to send after review.'),
});

const NoteSchema = z.object({
  note: z
    .string()
    .describe('The dictated note cleaned up: fillers removed, facts kept.'),
  outcome: z
    .enum([
      'INTERESTED',
      'CALL_BACK',
      'NOT_NOW',
      'NO_ANSWER',
      'WRONG_NUMBER',
      'NOT_INTERESTED',
      'UNKNOWN',
    ])
    .describe('How the contact went, or UNKNOWN if the note does not say.'),
  nextAction: z
    .string()
    .describe(
      'The next step mentioned, as a short instruction. Empty if none.',
    ),
  nextInDays: z
    .number()
    .int()
    .describe(
      'Days from today until the next step, from the note; -1 if not said.',
    ),
});

const CardSchema = z.object({
  name: z.string().describe('Person’s full name, empty if not shown.'),
  company: z.string().describe('Company or business name, empty if not shown.'),
  jobTitle: z.string().describe('Job title, empty if not shown.'),
  phone: z
    .string()
    .describe('Main phone number exactly as printed, empty if not shown.'),
  email: z.string().describe('Email address, empty if not shown.'),
  address: z.string().describe('Address on one line, empty if not shown.'),
});

export type Channel = 'WHATSAPP' | 'EMAIL' | 'SMS';

/**
 * Claude-powered helpers. Needs ANTHROPIC_API_KEY on the server. Prospect details
 * are sent to Anthropic's API to generate each answer.
 */
@Injectable()
export class AiService {
  private log = new Logger('Ai');
  private client?: Anthropic;

  constructor(private prisma: PrismaService) {}

  get configured() {
    return !!process.env.ANTHROPIC_API_KEY?.trim();
  }

  private get anthropic() {
    if (!this.configured)
      throw new ServiceUnavailableException(
        'The AI assistant isn’t switched on for this server yet.',
      );
    this.client ??= new Anthropic();
    return this.client;
  }

  /** One structured call. Refusals and API failures become plain messages. */
  private async ask<T>(
    schema: z.ZodType<T>,
    content: Anthropic.Beta.BetaContentBlockParam[] | string,
  ): Promise<T> {
    try {
      const res = await this.anthropic.beta.messages.parse({
        model: MODEL,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
        system: SYSTEM,
        messages: [{ role: 'user', content }],
      });
      if (res.stop_reason === 'refusal')
        throw new UnprocessableEntityException(
          'The assistant couldn’t help with this one. Try rewording it.',
        );
      if (!res.parsed_output)
        throw new BadGatewayException(
          'The assistant gave an incomplete answer. Please try again.',
        );
      return res.parsed_output;
    } catch (e) {
      if (e instanceof HttpException) throw e;
      if (e instanceof Anthropic.RateLimitError)
        throw new HttpException(
          'The assistant is busy right now. Try again in a minute.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      if (
        e instanceof Anthropic.AuthenticationError ||
        e instanceof Anthropic.PermissionDeniedError
      ) {
        this.log.error('Anthropic rejected the API key');
        throw new ServiceUnavailableException(
          'The AI assistant isn’t set up correctly on the server. Check the API key.',
        );
      }
      if (e instanceof Anthropic.BadRequestError) {
        this.log.error(e.message);
        throw new BadGatewayException(
          'The assistant couldn’t read that. Try again with less text or a clearer photo.',
        );
      }
      if (e instanceof Anthropic.APIConnectionError)
        throw new BadGatewayException(
          'We couldn’t reach the assistant. Check your connection and try again.',
        );
      if (e instanceof Anthropic.APIError) {
        this.log.error(`${e.status}: ${e.message}`);
        throw new BadGatewayException(
          'The assistant had a problem. Please try again.',
        );
      }
      throw e;
    }
  }

  /** Everything known about a prospect, as text for the model. */
  private async context(ownerId: string, id: string) {
    const p = await this.prisma.prospect.findFirst({
      where: { id, ownerId },
      include: {
        activities: { orderBy: { occurredAt: 'desc' }, take: 30 },
        balances: { orderBy: { month: 'desc' }, take: 6 },
        referredBy: { select: { name: true } },
        owner: {
          select: { name: true, jobTitle: true, phone: true, timezone: true },
        },
      },
    });
    if (!p)
      throw new NotFoundException(
        'We couldn’t find that prospect. It may have been deleted.',
      );
    const money = (v: bigint | null) =>
      v === null ? 'not entered' : `₦${Number(v).toLocaleString('en-NG')}`;
    const history = p.activities
      .map((a) => {
        const date = a.occurredAt.toISOString().slice(0, 10);
        if (a.type === 'STAGE_CHANGE')
          return `${date}: stage moved from ${STAGE_LABEL[a.fromStage!]} to ${STAGE_LABEL[a.toStage!]}`;
        return `${date}: ${a.type.toLowerCase()}${a.outcome ? ` (${a.outcome.toLowerCase().replace('_', ' ')})` : ''}${a.note ? `: ${a.note}` : ''}`;
      })
      .join('\n');
    const lines = [
      `Name: ${p.name}`,
      p.company && `Company: ${p.company}`,
      p.group && `Group: ${p.group}`,
      `Stage: ${STAGE_LABEL[p.stage]}`,
      p.tier && `Tier: ${p.tier}`,
      `Deposit potential: ${money(p.potential)}`,
      p.funded !== null && `Current balance: ${money(p.funded)}`,
      p.source && `Source: ${p.source.toLowerCase().replace('_', ' ')}`,
      p.referredBy && `Referred by: ${p.referredBy.name}`,
      p.wantsProducts.length &&
        `Interested in: ${p.wantsProducts.join(', ').toLowerCase()}`,
      p.holdsProducts.length &&
        `Already holds: ${p.holdsProducts.join(', ').toLowerCase()}`,
      p.area && `Area: ${p.area}`,
      p.nextAction && `Planned next step: ${p.nextAction}`,
      p.outcomeReason && `Outcome reason: ${p.outcomeReason}`,
      p.notes && `Notes: ${p.notes}`,
      p.balances.length &&
        `Recent balances: ${p.balances.map((b) => `${b.month.toISOString().slice(0, 7)} ${money(b.amount)}`).join(', ')}`,
    ].filter(Boolean);
    return {
      prospect: p,
      text: `<prospect>\n${lines.join('\n')}\n</prospect>\n<history newest_first="true">\n${history || 'No contact logged yet.'}\n</history>`,
      rm: p.owner,
      today: todayIn(p.owner.timezone),
    };
  }

  async brief(ownerId: string, id: string) {
    const { text, today } = await this.context(ownerId, id);
    return this.ask(
      BriefSchema,
      `Today is ${today}. I'm about to meet or call this prospect. Prepare a short brief I can read in under a minute.\n\n${text}`,
    );
  }

  async draft(ownerId: string, id: string, channel: Channel, goal?: string) {
    const { text, rm, prospect, today } = await this.context(ownerId, id);
    const templates = await this.prisma.template.findMany({
      where: { ownerId },
      orderBy: { position: 'asc' },
      take: 5,
      select: { body: true },
    });
    const style = templates.length
      ? `<my_messages>\nMessages I have written before, to match my tone (don't copy them):\n${templates.map((t) => `- ${t.body}`).join('\n')}\n</my_messages>`
      : '';
    const shape = {
      WHATSAPP:
        'a WhatsApp message: friendly, short (under 90 words), no subject, no sign-off block',
      SMS: 'an SMS: under 300 characters, plain text, no emojis, ends with my first name',
      EMAIL:
        'an email: a clear subject and a short body (under 150 words). Do not add a signature; it is added automatically',
    }[channel];
    return this.ask(
      DraftSchema,
      `Today is ${today}. Write ${shape} from me (${rm.name}${rm.jobTitle ? `, ${rm.jobTitle}` : ''}) to ${prospect.name}.
${goal ? `What I want it to do: ${goal}` : 'Move them to the next step, based on where things stand.'}
Refer to what happened before where it helps. Use their first name.

${text}
${style}`,
    );
  }

  /** Turns a dictated note into a clean note plus the outcome and next step. */
  async tidyNote(ownerId: string, transcript: string, prospectId?: string) {
    const ctx = prospectId ? await this.context(ownerId, prospectId) : null;
    const result = await this.ask(
      NoteSchema,
      `Clean up this dictated note from after a call or visit, then pull out how it went and the next step.${ctx ? `\nToday is ${ctx.today}.\n\n${ctx.text}` : ''}

<dictated_note>
${transcript}
</dictated_note>`,
    );
    return {
      note: result.note,
      outcome: result.outcome === 'UNKNOWN' ? null : result.outcome,
      nextAction: result.nextAction || null,
      nextInDays: result.nextInDays >= 0 ? result.nextInDays : null,
    };
  }

  async scanCard(dataUrl: string) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
    if (!m)
      throw new UnprocessableEntityException(
        'Upload a JPG, PNG or WebP photo of the card',
      );
    return this.ask(CardSchema, [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: m[1] as 'image/jpeg' | 'image/png' | 'image/webp',
          data: m[2],
        },
      },
      {
        type: 'text',
        text: 'Read this business card and pull out the contact details. Leave a field empty rather than guess.',
      },
    ]);
  }
}

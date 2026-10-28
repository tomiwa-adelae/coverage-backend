import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

const env = (k: string) => process.env[k]?.trim() || undefined;
const log = new Logger('Gemini');

/**
 * A backup that just answered while the main model was failing. It's tried
 * first for a while, so each request doesn't wait out the main one again.
 */
let preferred: { model: string; until: number } | null = null;
const PREFER_MS = 15 * 60_000;

export const geminiConfigured = () => !!env('GEMINI_API_KEY');

export type GeminiPart =
  { text: string } | { inlineData: { mimeType: string; data: string } };

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

/** Finish reasons that mean Gemini declined rather than failed. */
const BLOCKED = new Set([
  'SAFETY',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'RECITATION',
]);

/**
 * One Gemini generateContent call (GEMINI_API_KEY). With `jsonSchema` the
 * answer is JSON matching it. Returns the answer text.
 */
export async function geminiGenerate(opts: {
  parts: GeminiPart[];
  system?: string;
  jsonSchema?: object;
  maxTokens?: number;
  /** Longest wait for one attempt. */
  timeoutMs?: number;
  /** Longest wait in all, across retries and backup models. */
  deadlineMs?: number;
}) {
  const main = env('GEMINI_MODEL') ?? 'gemini-3.8-flash';
  // Other free models to try when the main one is overloaded. Ones Google
  // doesn't offer to this key (404) are skipped.
  const backups = (
    env('GEMINI_FALLBACK_MODEL') ?? 'gemini-3.6-flash,gemini-3.5-flash-lite'
  )
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== main);
  const base =
    env('GEMINI_BASE_URL') ?? 'https://generativelanguage.googleapis.com';
  const body = JSON.stringify({
    ...(opts.system && {
      systemInstruction: { parts: [{ text: opts.system }] },
    }),
    contents: [{ role: 'user', parts: opts.parts }],
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 8000,
      ...(opts.jsonSchema && {
        responseMimeType: 'application/json',
        responseJsonSchema: opts.jsonSchema,
      }),
    },
  });

  // Busy answers (429/5xx) usually pass in seconds, so the main model gets a
  // second try; a model that hangs until the timeout doesn't.
  const sticky =
    preferred && preferred.until > Date.now() ? preferred.model : null;
  const plan = sticky
    ? [sticky, main, ...backups.filter((m) => m !== sticky)]
    : [main, main, ...backups];
  const deadline = Date.now() + (opts.deadlineMs ?? 4 * 60_000);
  let res: Response | undefined;
  let detail = '';
  let timedOut = false;
  for (let i = 0; i < plan.length; i++) {
    const model = plan[i];
    if (i === 1 && !sticky && timedOut) continue;
    if (i === 1 && !sticky) await new Promise((r) => setTimeout(r, 2000));
    const left = deadline - Date.now();
    if (left < 10_000) break;
    try {
      res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': env('GEMINI_API_KEY') ?? '',
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(Math.min(opts.timeoutMs ?? 90_000, left)),
      });
    } catch (e) {
      const err = e as Error;
      timedOut = err.name === 'TimeoutError' || /timeout/i.test(err.message);
      log.warn(`${model}: ${err.message}`);
      res = undefined;
      continue;
    }
    timedOut = false;
    if (res.ok) {
      if (model !== main) {
        if (preferred?.model !== model)
          log.log(`answered by ${model}; trying it first for 15 minutes`);
        preferred = { model, until: Date.now() + PREFER_MS };
      } else preferred = null;
      break;
    }
    detail = (await res.text()).slice(0, 500);
    log.warn(`${model} ${res.status}: ${detail.replace(/\s+/g, ' ')}`);
    if (![404, 429, 500, 503, 504].includes(res.status)) break;
  }

  if (!res || (!res.ok && [404, 500, 503, 504].includes(res.status)))
    throw new ServiceUnavailableException(
      timedOut || res
        ? 'Google’s AI is very busy right now and didn’t answer in time. Please try again in a few minutes.'
        : 'We couldn’t reach the assistant. Check your connection and try again.',
    );
  if (!res.ok) {
    if (res.status === 429)
      throw new HttpException(
        'The assistant is busy right now (free plan limit). Try again in a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (
      res.status === 401 ||
      res.status === 403 ||
      /API_KEY_INVALID|API key not valid/i.test(detail)
    )
      throw new ServiceUnavailableException(
        'The AI assistant isn’t set up correctly on the server. Check the Gemini API key.',
      );
    if (res.status === 400)
      throw new BadGatewayException(
        `The assistant couldn’t read that. Try again with less text or a clearer photo. (${detail.slice(0, 160)})`,
      );
    throw new BadGatewayException(
      `The assistant had a problem (${res.status}). Please try again.`,
    );
  }

  const json = (await res.json()) as GeminiResponse;
  const candidate = json.candidates?.[0];
  if (
    json.promptFeedback?.blockReason ||
    BLOCKED.has(candidate?.finishReason ?? '')
  )
    throw new UnprocessableEntityException(
      'The assistant couldn’t help with this one. Try rewording it.',
    );
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought && p.text)
    .map((p) => p.text)
    .join('');
  if (!text || candidate?.finishReason === 'MAX_TOKENS')
    throw new BadGatewayException(
      'The assistant gave an incomplete answer. Please try again.',
    );
  return text;
}

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
  timeoutMs?: number;
}) {
  const main = env('GEMINI_MODEL') ?? 'gemini-3.8-flash';
  // An older model that's usually less busy, for when the main one is overloaded.
  const fallback = env('GEMINI_FALLBACK_MODEL') ?? 'gemini-2.5-flash';
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

  // Google answers 429/500/503/504 when it's busy; those usually pass in seconds.
  const plan =
    fallback === main ? [main, main, main] : [main, main, fallback, fallback];
  let res: Response | undefined;
  let detail = '';
  for (let i = 0; i < plan.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, i === 1 ? 1500 : 3000));
    try {
      res = await fetch(`${base}/v1beta/models/${plan[i]}:generateContent`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': env('GEMINI_API_KEY') ?? '',
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
    } catch (e) {
      log.warn(`${plan[i]}: ${(e as Error).message}`);
      res = undefined;
      continue;
    }
    if (res.ok) break;
    detail = (await res.text()).slice(0, 500);
    log.warn(`${plan[i]} ${res.status}: ${detail.replace(/\s+/g, ' ')}`);
    if (![429, 500, 503, 504].includes(res.status)) break;
  }

  if (!res)
    throw new BadGatewayException(
      'We couldn’t reach the assistant. Check your connection and try again.',
    );
  if (!res.ok) {
    if (res.status === 429)
      throw new HttpException(
        'The assistant is busy right now (free plan limit). Try again in a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (res.status === 503 || res.status === 500 || res.status === 504)
      throw new ServiceUnavailableException(
        'Google’s AI is overloaded right now. Please try again in a minute.',
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

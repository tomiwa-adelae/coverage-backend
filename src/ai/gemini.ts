import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

const env = (k: string) => process.env[k]?.trim() || undefined;

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
  const model = env('GEMINI_MODEL') ?? 'gemini-3.8-flash';
  const base =
    env('GEMINI_BASE_URL') ?? 'https://generativelanguage.googleapis.com';
  let res: Response;
  try {
    res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': env('GEMINI_API_KEY') ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
  } catch {
    throw new BadGatewayException(
      'We couldn’t reach the assistant. Check your connection and try again.',
    );
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
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

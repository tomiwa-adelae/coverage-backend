import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

const env = (k: string) => process.env[k]?.trim() || undefined;

type Provider = 'deepgram' | 'openai';

/** File extension each provider uses to recognise the recording's format. */
const EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

export const AUDIO_TYPES = Object.keys(EXT);

/**
 * Speech to text for voice debriefs. Deepgram (DEEPGRAM_API_KEY) is preferred:
 * it takes a list of names to listen for and keeps no audio after processing.
 * OpenAI (OPENAI_API_KEY) works too. TRANSCRIBE_PROVIDER picks one when both
 * keys are set. Audio goes straight to the provider and is never stored here.
 */
@Injectable()
export class TranscribeService {
  private log = new Logger('Transcribe');

  get provider(): Provider | null {
    const chosen = env('TRANSCRIBE_PROVIDER')?.toLowerCase();
    if (chosen === 'openai' && env('OPENAI_API_KEY')) return 'openai';
    if (chosen === 'deepgram' && env('DEEPGRAM_API_KEY')) return 'deepgram';
    if (env('DEEPGRAM_API_KEY')) return 'deepgram';
    if (env('OPENAI_API_KEY')) return 'openai';
    return null;
  }

  get configured() {
    return this.provider !== null;
  }

  /**
   * @param hints names and companies likely to come up, so they're spelt right
   */
  async transcribe(audio: Buffer, mime: string, hints: string[]) {
    const provider = this.provider;
    if (!provider)
      throw new ServiceUnavailableException(
        'Voice debriefs aren’t switched on for this server yet. You can type your debrief instead.',
      );
    const type = mime.split(';')[0].trim().toLowerCase();
    if (!EXT[type])
      throw new UnprocessableEntityException(
        'That recording format isn’t supported. Try recording again.',
      );
    let text: string;
    try {
      text =
        provider === 'deepgram'
          ? await this.deepgram(audio, type, hints)
          : await this.openai(audio, type, hints);
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      this.log.error(`${provider}: ${(e as Error).message}`);
      throw new BadGatewayException(
        'We couldn’t turn the recording into text. Please try again.',
      );
    }
    text = text.trim();
    if (!text)
      throw new UnprocessableEntityException(
        'We couldn’t hear any speech in that recording. Check your microphone and try again.',
      );
    return text;
  }

  private async deepgram(audio: Buffer, type: string, hints: string[]) {
    const qs = new URLSearchParams({
      model: env('DEEPGRAM_MODEL') ?? 'nova-3',
      language: env('DEEPGRAM_LANGUAGE') ?? 'en',
      smart_format: 'true',
      punctuate: 'true',
      paragraphs: 'true',
      // Keep the audio out of Deepgram's model training; it's client talk.
      mip_opt_out: 'true',
    });
    // Up to 500 tokens of key terms per request; ~1,200 characters stays under.
    let budget = 1200;
    for (const h of hints) {
      if (h.length > budget) break;
      qs.append('keyterm', h);
      budget -= h.length + 1;
    }
    const base = env('DEEPGRAM_BASE_URL') ?? 'https://api.deepgram.com';
    const res = await fetch(`${base}/v1/listen?${qs}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${env('DEEPGRAM_API_KEY')}`,
        'Content-Type': type,
      },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.status === 401 || res.status === 403) throw this.badKey('Deepgram');
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const json = (await res.json()) as {
      results?: {
        channels?: {
          alternatives?: {
            transcript?: string;
            paragraphs?: { transcript?: string };
          }[];
        }[];
      };
    };
    const alt = json.results?.channels?.[0]?.alternatives?.[0];
    return alt?.paragraphs?.transcript ?? alt?.transcript ?? '';
  }

  private async openai(audio: Buffer, type: string, hints: string[]) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type }),
      `debrief.${EXT[type]}`,
    );
    form.append('model', env('OPENAI_TRANSCRIBE_MODEL') ?? 'gpt-4o-transcribe');
    form.append('response_format', 'json');
    form.append(
      'prompt',
      `A Nigerian bank relationship manager's notes about customers and prospects.${
        hints.length ? ` Names that may come up: ${hints.join(', ')}.` : ''
      }`.slice(0, 1500),
    );
    const base = env('OPENAI_BASE_URL') ?? 'https://api.openai.com';
    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('OPENAI_API_KEY')}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    if (res.status === 401 || res.status === 403) throw this.badKey('OpenAI');
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return ((await res.json()) as { text?: string }).text ?? '';
  }

  private badKey(name: string) {
    this.log.error(`${name} rejected the API key`);
    return new ServiceUnavailableException(
      'Voice debriefs aren’t set up correctly on the server. Check the speech-to-text key.',
    );
  }
}

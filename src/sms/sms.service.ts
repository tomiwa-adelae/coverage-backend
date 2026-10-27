import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

const env = (k: string) => process.env[k]?.trim() || undefined;

/** Nigerian local numbers (0803…) become 234803…; other numbers keep their digits. */
export function internationalNumber(phone: string) {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.startsWith('0') && digits.length === 11)
    return `234${digits.slice(1)}`;
  return digits;
}

/**
 * Sends SMS through Termii over HTTP. Needs TERMII_API_KEY and a sender ID approved
 * by Termii (TERMII_SENDER_ID). The "dnd" route reaches numbers on Do-Not-Disturb,
 * which "generic" silently drops, so it is the default.
 */
@Injectable()
export class SmsService {
  private log = new Logger('Sms');

  get configured() {
    return !!env('TERMII_API_KEY') && !!env('TERMII_SENDER_ID');
  }

  async send(to: string, body: string) {
    if (!this.configured)
      throw new ServiceUnavailableException(
        'Sending SMS from Coverage isn’t switched on yet. Use “Open SMS app” to send from your phone for now.',
      );
    const number = internationalNumber(to);
    if (number.length < 10)
      throw new BadRequestException(
        'This prospect’s phone number looks incomplete. Fix it in their details first.',
      );

    const base = env('TERMII_BASE_URL') ?? 'https://api.ng.termii.com';
    const res = await fetch(`${base}/api/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env('TERMII_API_KEY'),
        to: number,
        from: env('TERMII_SENDER_ID'),
        sms: body,
        type: 'plain',
        channel: env('TERMII_CHANNEL') ?? 'dnd',
      }),
    }).catch((e: Error) => {
      this.log.error(e);
      throw new BadGatewayException(
        'We couldn’t reach the SMS service. Please try again.',
      );
    });

    const data = (await res.json().catch(() => null)) as {
      message?: string;
      message_id?: string;
    } | null;
    if (!res.ok || !data?.message_id) {
      this.log.error(`termii ${res.status}: ${data?.message ?? ''}`);
      throw new BadGatewayException(
        data?.message
          ? `The SMS service rejected the message: ${data.message}`
          : 'The SMS service rejected the message. Please try again.',
      );
    }
  }
}

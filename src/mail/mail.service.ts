import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Display name in the From header, e.g. the relationship manager's name. */
  fromName?: string;
  replyTo?: string;
}

const env = (k: string) => process.env[k]?.trim() || undefined;

/**
 * Sends email over HTTP (no SDKs). Uses Resend when RESEND_API_KEY is set,
 * otherwise Mailjet when MAILJET_API_PUBLIC_KEY/PRIVATE_KEY are set.
 * EMAIL_FROM must be an address on a domain verified with that provider.
 */
@Injectable()
export class MailService {
  private log = new Logger('Mail');

  private get provider(): 'resend' | 'mailjet' | null {
    if (env('RESEND_API_KEY')) return 'resend';
    if (env('MAILJET_API_PUBLIC_KEY') && env('MAILJET_API_PRIVATE_KEY'))
      return 'mailjet';
    return null;
  }

  private get from() {
    // Deliberately no fallback to other apps' sender settings in a shared .env.
    return env('EMAIL_FROM');
  }

  get configured() {
    return !!this.provider && !!this.from;
  }

  async send(mail: Mail) {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'Sending email from Coverage isn’t switched on yet. Use “Open it there” to send from your own mail app for now.',
      );
    }
    const name = mail.fromName?.replace(/[<>"]/g, '');
    const res = await (
      this.provider === 'resend'
        ? this.resend(mail, name)
        : this.mailjet(mail, name)
    ).catch((e: Error) => {
      this.log.error(e);
      throw new BadGatewayException(
        'We couldn’t reach the email service. Please try again.',
      );
    });

    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as {
        message?: string;
        ErrorMessage?: string;
        Messages?: { Errors?: { ErrorMessage?: string }[] }[];
      } | null;
      const reason =
        detail?.message ??
        detail?.ErrorMessage ??
        detail?.Messages?.[0]?.Errors?.[0]?.ErrorMessage;
      this.log.error(`${this.provider} ${res.status}: ${reason ?? ''}`);
      throw new BadGatewayException(
        reason
          ? `The email service rejected the message: ${reason}`
          : 'The email service rejected the message. Please try again.',
      );
    }
  }

  private resend(mail: Mail, name?: string) {
    return fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: name ? `${name} <${this.from}>` : this.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        reply_to: mail.replyTo,
      }),
    });
  }

  private mailjet(mail: Mail, name?: string) {
    const auth = Buffer.from(
      `${env('MAILJET_API_PUBLIC_KEY')}:${env('MAILJET_API_PRIVATE_KEY')}`,
    ).toString('base64');
    return fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Messages: [
          {
            From: { Email: this.from, Name: name },
            To: [{ Email: mail.to }],
            ReplyTo: mail.replyTo ? { Email: mail.replyTo } : undefined,
            Subject: mail.subject,
            TextPart: mail.text,
            HTMLPart: mail.html,
          },
        ],
      }),
    });
  }
}

export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

/** Plain text to simple, readable HTML paragraphs. */
export const textToHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

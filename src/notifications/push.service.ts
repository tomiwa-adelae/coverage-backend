import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

const env = (k: string) => process.env[k]?.trim() || undefined;

export interface PushPayload {
  title: string;
  body: string;
  /** Page to open when the notification is tapped. */
  url?: string;
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag?: string;
}

/**
 * Web push to installed/allowed browsers. Needs VAPID_PUBLIC_KEY and
 * VAPID_PRIVATE_KEY (generate once with `npx web-push generate-vapid-keys`).
 */
@Injectable()
export class PushService {
  private log = new Logger('Push');
  private ready = false;

  get publicKey() {
    return env('VAPID_PUBLIC_KEY') ?? null;
  }

  get configured() {
    return !!env('VAPID_PUBLIC_KEY') && !!env('VAPID_PRIVATE_KEY');
  }

  private setup() {
    if (this.ready) return;
    webpush.setVapidDetails(
      env('VAPID_SUBJECT') ?? 'mailto:no-reply@coverage.app',
      env('VAPID_PUBLIC_KEY')!,
      env('VAPID_PRIVATE_KEY')!,
    );
    this.ready = true;
  }

  constructor(private prisma: PrismaService) {}

  async subscribe(
    userId: string,
    sub: { endpoint: string; p256dh: string; auth: string },
    userAgent?: string,
  ) {
    // An endpoint belongs to one browser; if someone else signs in there, it moves.
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { ...sub, userId, userAgent },
      update: { ...sub, userId, userAgent },
    });
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  /**
   * Sends to every browser the user allowed. Returns how many received it.
   * `ttl` is how long the push service keeps trying a phone that's offline;
   * high urgency asks Android to wake a sleeping phone straight away.
   */
  async send(
    userId: string,
    payload: PushPayload,
    opts: { ttl?: number; urgency?: 'normal' | 'high' } = {},
  ) {
    if (!this.configured) return 0;
    this.setup();
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId },
    });
    let delivered = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
            {
              TTL: Math.max(60, Math.round(opts.ttl ?? 6 * 60 * 60)),
              urgency: opts.urgency ?? 'normal',
            },
          );
          delivered++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          // Gone or unknown: the browser dropped the subscription.
          if (status === 404 || status === 410)
            await this.prisma.pushSubscription.delete({ where: { id: s.id } });
          else
            this.log.warn(
              `push failed (${status ?? 'network'}): ${(e as Error).message}`,
            );
        }
      }),
    );
    return delivered;
  }

  async sendTest(userId: string) {
    if (!this.configured)
      throw new ServiceUnavailableException(
        'Phone notifications aren’t switched on for this server yet.',
      );
    const count = await this.send(
      userId,
      {
        title: 'Coverage notifications are on',
        body: 'You’ll get reminders and your morning list here.',
        url: '/',
        tag: 'test',
      },
      { ttl: 10 * 60, urgency: 'high' },
    );
    if (!count)
      throw new ServiceUnavailableException(
        'We couldn’t reach this device. Turn notifications off and on again.',
      );
    return { delivered: count };
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { timingSafeEqual } from 'crypto';
import { Client, CurrentUser, Public } from '../common/decorators';
import type { AuthUser, ClientInfo } from '../common/decorators';
import { MailService } from '../mail/mail.service';
import { DigestService } from './digest.service';
import { PushService } from './push.service';

class PushKeys {
  @IsString() @IsNotEmpty() @MaxLength(200) p256dh: string;
  @IsString() @IsNotEmpty() @MaxLength(100) auth: string;
}

class SubscribeDto {
  @IsUrl({ protocols: ['https'] }, { message: 'Invalid push endpoint' })
  @MaxLength(1000)
  endpoint: string;

  @ValidateNested()
  @Type(() => PushKeys)
  keys: PushKeys;
}

class UnsubscribeDto {
  @IsString() @MaxLength(1000) endpoint: string;
}

@Controller('notifications')
export class NotificationsController {
  constructor(
    private push: PushService,
    private digest: DigestService,
    private mail: MailService,
  ) {}

  /** What this server can deliver, plus the key browsers need to subscribe. */
  @Get('config')
  config() {
    return {
      pushKey: this.push.configured ? this.push.publicKey : null,
      email: this.mail.configured,
    };
  }

  @Post('subscriptions')
  @HttpCode(204)
  async subscribe(
    @CurrentUser() user: AuthUser,
    @Body() dto: SubscribeDto,
    @Client() client: ClientInfo,
  ) {
    await this.push.subscribe(
      user.sub,
      { endpoint: dto.endpoint, ...dto.keys },
      client.userAgent,
    );
  }

  @Post('subscriptions/remove')
  @HttpCode(204)
  async unsubscribe(
    @CurrentUser() user: AuthUser,
    @Body() dto: UnsubscribeDto,
  ) {
    await this.push.unsubscribe(user.sub, dto.endpoint);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('test')
  @HttpCode(200)
  test(@CurrentUser() user: AuthUser) {
    return this.push.sendTest(user.sub);
  }

  /** Sends this morning's summary now, to try the settings. */
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('digest')
  @HttpCode(200)
  async sendDigest(@CurrentUser() user: AuthUser) {
    if (!this.mail.configured && !this.push.configured)
      throw new BadRequestException(
        'Neither email nor phone notifications are switched on for this server yet.',
      );
    await this.digest.sendDigest(user.sub);
    return { ok: true };
  }

  @Get('weekly-report')
  weeklyReport(@CurrentUser() user: AuthUser) {
    return this.digest.weeklyReport(user.sub);
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('weekly-report')
  @HttpCode(200)
  async sendWeeklyReport(@CurrentUser() user: AuthUser) {
    if (!this.mail.configured)
      throw new BadRequestException(
        'Sending email from Coverage isn’t switched on yet, so the report can’t be emailed.',
      );
    await this.digest.sendWeeklyReport(user.sub);
    return { ok: true };
  }
}

/**
 * For hosts that sleep when idle (Render free tier): point an external scheduler
 * (cron-job.org, GitHub Actions) at POST /api/jobs/run every 15 minutes with the
 * header `x-cron-secret: <CRON_SECRET>`.
 */
@Controller('jobs')
export class JobsController {
  constructor(private digest: DigestService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('run')
  @HttpCode(200)
  run(@Headers('x-cron-secret') secret?: string) {
    const expected = process.env.CRON_SECRET?.trim();
    const ok =
      !!expected &&
      !!secret &&
      secret.length === expected.length &&
      timingSafeEqual(Buffer.from(secret), Buffer.from(expected));
    if (!ok) throw new NotFoundException();
    return this.digest.runDue();
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Client, CurrentUser } from '../common/decorators';
import type { AuthUser, ClientInfo } from '../common/decorators';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordConfirmDto, TwoFactorCodeDto } from './auth.dto';
import { AuthService } from './auth.service';

/** Signed-in devices, two-step sign-in and the security log. */
@Controller('security')
export class SecurityController {
  constructor(
    private auth: AuthService,
    private audit: AuditService,
    private prisma: PrismaService,
  ) {}

  @Get()
  async overview(@CurrentUser() user: AuthUser) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.sub },
      select: { twoFactorEnabled: true, backupCodes: true },
    });
    return {
      twoFactorEnabled: u.twoFactorEnabled,
      backupCodesLeft: u.backupCodes.length,
      sessions: await this.auth.sessions(user),
    };
  }

  @Get('log')
  log(@CurrentUser() user: AuthUser) {
    return this.audit.list(user.sub);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ) {
    return this.auth.revokeSession(user, id, client);
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  revokeOthers(@CurrentUser() user: AuthUser, @Client() client: ClientInfo) {
    return this.auth.revokeOtherSessions(user, client);
  }

  @Post('two-factor/setup')
  @HttpCode(200)
  setup(@CurrentUser() user: AuthUser) {
    return this.auth.setupTwoFactor(user.sub);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('two-factor/enable')
  @HttpCode(200)
  enable(
    @CurrentUser() user: AuthUser,
    @Body() dto: TwoFactorCodeDto,
    @Client() client: ClientInfo,
  ) {
    return this.auth.enableTwoFactor(user.sub, dto.code, client);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('two-factor/disable')
  @HttpCode(200)
  async disable(
    @CurrentUser() user: AuthUser,
    @Body() dto: PasswordConfirmDto,
    @Client() client: ClientInfo,
  ) {
    await this.auth.disableTwoFactor(user.sub, dto.password, client);
    return { ok: true };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('two-factor/backup-codes')
  @HttpCode(200)
  backupCodes(@CurrentUser() user: AuthUser, @Body() dto: PasswordConfirmDto) {
    return this.auth.regenerateBackupCodes(user.sub, dto.password);
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, ClientInfo } from '../common/decorators';
import { MailService, escapeHtml } from '../mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from './auth.constants';
import {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  TwoFactorLoginDto,
} from './auth.dto';
import { newBackupCodes, newTotpSecret, otpauthUrl, verifyTotp } from './totp';

const RESET_TTL_MINUTES = 30;
const TICKET_TTL_SECONDS = 5 * 60;

/** Where reset links point: APP_URL, else the first FRONTEND_URL. */
const appUrl = () =>
  (
    process.env.APP_URL ||
    process.env.FRONTEND_URL?.split(',')[0] ||
    'http://localhost:3000'
  )
    .trim()
    .replace(/\/$/, '');

// Refresh tokens are long random JWTs, so a fast hash is enough. bcrypt would only read
// the first 72 bytes, which are identical across one user's tokens.
const sha256 = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** Password was right but a second step is needed; the ticket proves the first. */
export interface TwoFactorChallenge {
  twoFactor: true;
  ticket: string;
}

type SessionUser = { id: string; email: string; role: string };

/** "AB12 CD34" or "ab12cd34" -> "ab12-cd34"; 6-digit codes pass through. */
const normaliseCode = (code: string) => {
  const c = code.replace(/\s/g, '').toLowerCase();
  return /^[a-z0-9]{8}$/.test(c) ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

@Injectable()
export class AuthService {
  private log = new Logger('Auth');

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private mail: MailService,
    private audit: AuditService,
  ) {}

  async register(dto: RegisterDto, client: ClientInfo): Promise<Tokens> {
    if (process.env.ALLOW_SIGNUP !== 'true') {
      throw new ForbiddenException('Sign-up is closed');
    }
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing)
      throw new ConflictException({
        statusCode: 409,
        message: 'An account with this email already exists. Sign in instead.',
        errors: { email: 'An account with this email already exists' },
      });

    const user = await this.prisma.user.create({
      data: {
        name: dto.name.trim(),
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 12),
      },
    });
    await this.audit.record(user.id, 'auth.register', client);
    return this.startSession(user, client);
  }

  async login(
    dto: LoginDto,
    client: ClientInfo,
  ): Promise<Tokens | TwoFactorChallenge> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    const ok = user && (await bcrypt.compare(dto.password, user.passwordHash));
    if (!ok) {
      if (user) await this.audit.record(user.id, 'auth.login_failed', client);
      throw new UnauthorizedException(
        'That email and password don’t match. Check them and try again.',
      );
    }
    if (user.twoFactorEnabled) {
      const ticket = await this.jwt.signAsync(
        { sub: user.id, purpose: '2fa' },
        {
          secret: process.env.ACCESS_TOKEN_SECRET,
          expiresIn: TICKET_TTL_SECONDS,
        },
      );
      return { twoFactor: true, ticket };
    }
    await this.audit.record(user.id, 'auth.login', client);
    return this.startSession(user, client);
  }

  /** Second step: a code from the authenticator app, or a one-time backup code. */
  async loginTwoFactor(
    dto: TwoFactorLoginDto,
    client: ClientInfo,
  ): Promise<Tokens> {
    let sub: string;
    try {
      const t = await this.jwt.verifyAsync<{ sub: string; purpose: string }>(
        dto.ticket,
        { secret: process.env.ACCESS_TOKEN_SECRET },
      );
      if (t.purpose !== '2fa') throw new Error('Wrong token');
      sub = t.sub;
    } catch {
      throw new UnauthorizedException(
        'Your sign-in took too long. Enter your password again.',
      );
    }
    const user = await this.prisma.user.findUnique({ where: { id: sub } });
    if (!user?.twoFactorEnabled || !user.twoFactorSecret)
      throw new UnauthorizedException(
        'Two-step sign-in is no longer on for this account. Sign in again.',
      );

    const code = normaliseCode(dto.code);
    if (verifyTotp(user.twoFactorSecret, code)) {
      await this.audit.record(
        user.id,
        'auth.login',
        client,
        'With two-step code',
      );
      return this.startSession(user, client);
    }
    const hash = sha256(code);
    if (user.backupCodes.includes(hash)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { backupCodes: user.backupCodes.filter((c) => c !== hash) },
      });
      const left = user.backupCodes.length - 1;
      await this.audit.record(
        user.id,
        'auth.backup_code_used',
        client,
        `${left} backup code${left === 1 ? '' : 's'} left`,
      );
      return this.startSession(user, client);
    }
    await this.audit.record(
      user.id,
      'auth.login_failed',
      client,
      'Wrong two-step code',
    );
    throw new UnauthorizedException({
      statusCode: 401,
      message: 'That code isn’t right. Check your app and try again.',
      errors: { code: 'That code isn’t right' },
    });
  }

  async refresh(
    refreshToken: string | undefined,
    client: ClientInfo,
  ): Promise<Tokens> {
    if (!refreshToken) throw new UnauthorizedException();
    let payload: AuthUser;
    try {
      payload = await this.jwt.verifyAsync<AuthUser>(refreshToken, {
        secret: process.env.REFRESH_TOKEN_SECRET,
      });
    } catch {
      throw new UnauthorizedException();
    }
    const session = payload.sid
      ? await this.prisma.session.findUnique({
          where: { id: payload.sid },
          include: { user: true },
        })
      : null;
    const valid =
      session &&
      session.expiresAt > new Date() &&
      timingSafeEqual(
        Buffer.from(sha256(refreshToken)),
        Buffer.from(session.tokenHash),
      );
    if (!valid) throw new UnauthorizedException();
    return this.rotate(session.user, session.id, client);
  }

  /**
   * Emails a one-time reset link. Looks the same whether or not the email has an
   * account, so the form can't be used to discover who is registered.
   */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;

    const token = randomBytes(32).toString('base64url');
    await this.prisma.$transaction([
      // Only the newest link works.
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
        },
      }),
    ]);

    const link = `${appUrl()}/reset-password?token=${token}`;
    if (!this.mail.configured) {
      // Local development without an email provider: print the link instead.
      this.log.warn(`Email not configured. Reset link for ${email}: ${link}`);
      return;
    }
    const first = user.name.split(' ')[0];
    await this.mail.send({
      to: user.email,
      fromName: 'Coverage',
      subject: 'Reset your Coverage password',
      text: `Hi ${first},\n\nUse this link to choose a new password. It expires in ${RESET_TTL_MINUTES} minutes and works once:\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
      html: `<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;color:#1f2d35">
<div style="background:#30444F;padding:20px 24px;border-radius:12px 12px 0 0"><span style="color:#FDB813;font-weight:700;font-size:18px">Coverage</span></div>
<div style="border:1px solid #e3e8eb;border-top:0;padding:24px;border-radius:0 0 12px 12px">
<p>Hi ${escapeHtml(first)},</p>
<p>Use the button below to choose a new password. The link expires in ${RESET_TTL_MINUTES} minutes and works once.</p>
<p style="margin:28px 0"><a href="${link}" style="background:#30444F;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Reset password</a></p>
<p style="color:#5b6b74;font-size:13px">If you didn't ask for this, you can ignore this email. Your password won't change.</p>
</div></div>`,
    });
  }

  /** Sets a new password from a reset link and signs the user in. */
  async resetPassword(
    dto: ResetPasswordDto,
    client: ClientInfo,
  ): Promise<Tokens> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(dto.token) },
      include: { user: true },
    });
    if (!record || record.usedAt)
      throw new BadRequestException(
        'This reset link is invalid or has already been used. Request a new one.',
      );
    if (record.expiresAt < new Date())
      throw new BadRequestException(
        'This reset link has expired. Request a new one.',
      );

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: await bcrypt.hash(dto.password, 12) },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      // Anyone who knew the old password is signed out everywhere.
      this.prisma.session.deleteMany({ where: { userId: record.userId } }),
    ]);
    await this.audit.record(record.userId, 'auth.password_reset', client);
    return this.startSession(record.user, client);
  }

  async changePassword(
    auth: AuthUser,
    dto: ChangePasswordDto,
    client: ClientInfo,
  ) {
    const userId = auth.sub;
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const fail = (field: string, message: string) =>
      new BadRequestException({
        statusCode: 400,
        message,
        errors: { [field]: message },
      });
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash)))
      throw fail('currentPassword', 'Your current password is incorrect');
    if (dto.currentPassword === dto.newPassword)
      throw fail(
        'newPassword',
        'Choose a password different from your current one',
      );
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) },
      }),
      // Other devices are signed out; this one stays in.
      this.prisma.session.deleteMany({
        where: { userId, id: { not: auth.sid ?? '' } },
      }),
    ]);
    await this.audit.record(userId, 'auth.password_changed', client);
    const current = auth.sid
      ? await this.prisma.session.findUnique({ where: { id: auth.sid } })
      : null;
    return current
      ? this.rotate(user, current.id, client)
      : this.startSession(user, client);
  }

  async logout(auth: AuthUser, client: ClientInfo) {
    if (auth.sid)
      await this.prisma.session.deleteMany({ where: { id: auth.sid } });
    await this.audit.record(auth.sub, 'auth.logout', client);
  }

  // ------------------------------------------------------------ devices

  async sessions(auth: AuthUser) {
    const rows = await this.prisma.session.findMany({
      where: { userId: auth.sub, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      current: s.id === auth.sid,
    }));
  }

  async revokeSession(auth: AuthUser, id: string, client: ClientInfo) {
    if (id === auth.sid)
      throw new BadRequestException(
        'To sign out this device, use Sign out instead.',
      );
    const { count } = await this.prisma.session.deleteMany({
      where: { id, userId: auth.sub },
    });
    if (!count)
      throw new BadRequestException('That device is already signed out.');
    await this.audit.record(auth.sub, 'session.revoked', client);
  }

  async revokeOtherSessions(auth: AuthUser, client: ClientInfo) {
    const { count } = await this.prisma.session.deleteMany({
      where: { userId: auth.sub, id: { not: auth.sid ?? '' } },
    });
    await this.audit.record(
      auth.sub,
      'session.revoked_all',
      client,
      `${count} device${count === 1 ? '' : 's'}`,
    );
    return { count };
  }

  // ------------------------------------------------------------ two-step sign-in

  /** Creates a fresh secret to scan. It only takes effect once a code is confirmed. */
  async setupTwoFactor(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (user.twoFactorEnabled)
      throw new BadRequestException('Two-step sign-in is already on.');
    const secret = newTotpSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret },
    });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  async enableTwoFactor(userId: string, code: string, client: ClientInfo) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (user.twoFactorEnabled)
      throw new BadRequestException('Two-step sign-in is already on.');
    if (!user.twoFactorSecret)
      throw new BadRequestException('Start the setup again to get a new code.');
    if (!verifyTotp(user.twoFactorSecret, code))
      throw new BadRequestException({
        statusCode: 400,
        message:
          'That code isn’t right. Check the time on your phone is set automatically and try again.',
        errors: { code: 'That code isn’t right' },
      });
    const backupCodes = newBackupCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true, backupCodes: backupCodes.map(sha256) },
    });
    await this.audit.record(userId, 'auth.2fa_enabled', client);
    return { backupCodes };
  }

  async disableTwoFactor(userId: string, password: string, client: ClientInfo) {
    await this.checkPassword(userId, password);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        backupCodes: [],
      },
    });
    await this.audit.record(userId, 'auth.2fa_disabled', client);
  }

  async regenerateBackupCodes(userId: string, password: string) {
    const user = await this.checkPassword(userId, password);
    if (!user.twoFactorEnabled)
      throw new BadRequestException('Turn on two-step sign-in first.');
    const backupCodes = newBackupCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: { backupCodes: backupCodes.map(sha256) },
    });
    return { backupCodes };
  }

  private async checkPassword(userId: string, password: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!(await bcrypt.compare(password, user.passwordHash)))
      throw new BadRequestException({
        statusCode: 400,
        message: 'Your password is incorrect',
        errors: { password: 'Your password is incorrect' },
      });
    return user;
  }

  // ------------------------------------------------------------ tokens

  private async startSession(user: SessionUser, client: ClientInfo) {
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        // Placeholder until the token exists; rotate() stores the real hash.
        tokenHash: randomUUID(),
        userAgent: client.userAgent,
        ip: client.ip,
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
      },
    });
    return this.rotate(user, session.id, client);
  }

  /** Sign a new token pair and store the new refresh hash on the session. */
  private async rotate(
    user: SessionUser,
    sid: string,
    client: ClientInfo,
  ): Promise<Tokens> {
    const payload: AuthUser = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sid,
    };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: process.env.ACCESS_TOKEN_SECRET,
        expiresIn: ACCESS_TTL_SECONDS,
      }),
      // jti makes every refresh token unique, so a rotated-out token never matches again.
      this.jwt.signAsync(
        { ...payload, jti: randomUUID() },
        {
          secret: process.env.REFRESH_TOKEN_SECRET,
          expiresIn: REFRESH_TTL_SECONDS,
        },
      ),
    ]);
    await this.prisma.session.update({
      where: { id: sid },
      data: {
        tokenHash: sha256(refreshToken),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
        ip: client.ip,
        userAgent: client.userAgent,
      },
    });
    return { accessToken, refreshToken };
  }
}

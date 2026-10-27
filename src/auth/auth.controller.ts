import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { Client, CurrentUser, Public } from '../common/decorators';
import type { AuthUser, ClientInfo } from '../common/decorators';
import {
  ACCESS_COOKIE,
  ACCESS_TTL_SECONDS,
  REFRESH_COOKIE,
  REFRESH_TTL_SECONDS,
} from './auth.constants';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  TwoFactorLoginDto,
} from './auth.dto';
import { AuthService, Tokens } from './auth.service';

// The frontend proxies /api to this server, so cookies are first-party and Lax is enough.
const base: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

type Cookies = Record<string, string | undefined>;

function setCookies(res: Response, tokens: Tokens) {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...base,
    maxAge: ACCESS_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...base,
    maxAge: REFRESH_TTL_SECONDS * 1000,
  });
}

function clearCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, base);
  res.clearCookie(REFRESH_COOKIE, base);
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    setCookies(res, await this.auth.register(dto, client));
    return { ok: true };
  }

  /** Signs in, or answers `{ twoFactor: true, ticket }` when a code is needed next. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto, client);
    if ('twoFactor' in result) return result;
    setCookies(res, result);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login/two-factor')
  async loginTwoFactor(
    @Body() dto: TwoFactorLoginDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    setCookies(res, await this.auth.loginTwoFactor(dto, client));
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(200)
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.email);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('reset-password')
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    setCookies(res, await this.auth.resetPassword(dto, client));
    return { ok: true };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    setCookies(res, await this.auth.changePassword(user, dto, client));
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      setCookies(
        res,
        await this.auth.refresh(
          (req.cookies as Cookies)[REFRESH_COOKIE],
          client,
        ),
      );
    } catch (e) {
      // A dead session must not leave cookies behind, or the frontend proxy keeps
      // treating the browser as signed in and bounces /login back to /.
      clearCookies(res);
      throw e;
    }
    return { ok: true };
  }

  @HttpCode(200)
  @Post('logout')
  async logout(
    @CurrentUser() user: AuthUser,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(user, client);
    clearCookies(res);
    return { ok: true };
  }
}

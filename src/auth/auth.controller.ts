import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { CurrentUser, Public } from '../common/decorators';
import type { AuthUser } from '../common/decorators';
import {
  ACCESS_COOKIE,
  ACCESS_TTL_SECONDS,
  REFRESH_COOKIE,
  REFRESH_TTL_SECONDS,
} from './auth.constants';
import { LoginDto, RegisterDto } from './auth.dto';
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
    @Res({ passthrough: true }) res: Response,
  ) {
    setCookies(res, await this.auth.register(dto));
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    setCookies(res, await this.auth.login(dto));
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      setCookies(
        res,
        await this.auth.refresh((req.cookies as Cookies)[REFRESH_COOKIE]),
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
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(user.sub);
    clearCookies(res);
    return { ok: true };
  }
}

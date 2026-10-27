import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Skip the global JWT guard for this route. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthUser {
  sub: string;
  email: string;
  role: string;
  /** Session id; tokens issued before sessions existed lack it. */
  sid?: string;
}

/** The authenticated user's token payload. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<{ user: AuthUser }>().user,
);

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

/** Caller's IP and browser, for the session list and security log. */
export const Client = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientInfo => {
    const req = ctx
      .switchToHttp()
      .getRequest<{ ip?: string; headers: Record<string, unknown> }>();
    const ua = req.headers['user-agent'];
    return {
      ip: req.ip,
      userAgent: typeof ua === 'string' ? ua.slice(0, 300) : undefined,
    };
  },
);

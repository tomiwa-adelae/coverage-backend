import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthUser, IS_PUBLIC_KEY } from '../common/decorators';
import { ACCESS_COOKIE } from './auth.constants';

/** Global guard: every route needs a valid access token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const token =
      (req.cookies as Record<string, string | undefined>)[ACCESS_COOKIE] ??
      (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token) throw new UnauthorizedException();

    try {
      req['user'] = await this.jwt.verifyAsync<AuthUser>(token, {
        secret: process.env.ACCESS_TOKEN_SECRET,
      });
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}

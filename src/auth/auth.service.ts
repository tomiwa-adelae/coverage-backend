import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/decorators';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from './auth.constants';
import { LoginDto, RegisterDto } from './auth.dto';

// Refresh tokens are long random JWTs, so a fast hash is enough. bcrypt would only read
// the first 72 bytes, which are identical across one user's tokens.
const sha256 = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<Tokens> {
    if (process.env.ALLOW_SIGNUP !== 'true') {
      throw new ForbiddenException('Sign-up is closed');
    }
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing)
      throw new ConflictException('An account with this email exists');

    const user = await this.prisma.user.create({
      data: {
        name: dto.name.trim(),
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 12),
      },
    });
    return this.issue(user);
  }

  async login(dto: LoginDto): Promise<Tokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    const ok = user && (await bcrypt.compare(dto.password, user.passwordHash));
    if (!ok) throw new UnauthorizedException('Wrong email or password');
    return this.issue(user);
  }

  async refresh(refreshToken: string | undefined): Promise<Tokens> {
    if (!refreshToken) throw new UnauthorizedException();
    let payload: AuthUser;
    try {
      payload = await this.jwt.verifyAsync<AuthUser>(refreshToken, {
        secret: process.env.REFRESH_TOKEN_SECRET,
      });
    } catch {
      throw new UnauthorizedException();
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    const valid =
      user?.refreshTokenHash &&
      timingSafeEqual(
        Buffer.from(sha256(refreshToken)),
        Buffer.from(user.refreshTokenHash),
      );
    if (!valid) throw new UnauthorizedException();
    return this.issue(user);
  }

  async logout(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshTokenHash: null },
    });
  }

  /** Sign a new token pair and rotate the stored refresh hash. */
  private async issue(user: {
    id: string;
    email: string;
    role: string;
  }): Promise<Tokens> {
    const payload: AuthUser = {
      sub: user.id,
      email: user.email,
      role: user.role,
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
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash: sha256(refreshToken) },
    });
    return { accessToken, refreshToken };
  }
}

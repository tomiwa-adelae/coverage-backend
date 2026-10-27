import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { User } from '@prisma/client';
import { CurrentUser } from '../common/decorators';
import type { AuthUser } from '../common/decorators';
import { toDate } from '../common/dates';
import { PrismaService } from '../prisma/prisma.service';

class UpdateMeDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional() @IsInt() @Min(1) targetAmount?: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  targetStartDate?: string;

  @IsOptional() @IsTimeZone() timezone?: string;

  @IsOptional() @IsInt() @Min(1) @Max(200) dailyGoal?: number;
}

const view = (u: User) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  timezone: u.timezone,
  dailyGoal: u.dailyGoal,
  targetAmount: Number(u.targetAmount),
  targetStartDate: u.targetStartDate.toISOString().slice(0, 10),
});

@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService) {}

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return view(
      await this.prisma.user.findUniqueOrThrow({ where: { id: user.sub } }),
    );
  }

  @Patch('me')
  async update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    const u = await this.prisma.user.update({
      where: { id: user.sub },
      data: {
        name: dto.name?.trim(),
        timezone: dto.timezone,
        dailyGoal: dto.dailyGoal,
        targetAmount:
          dto.targetAmount === undefined ? undefined : BigInt(dto.targetAmount),
        targetStartDate: dto.targetStartDate
          ? toDate(dto.targetStartDate)
          : undefined,
      },
    });
    return view(u);
  }
}

import { Body, Controller, Delete, Get, Patch, Put } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  ValidateIf,
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

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class UpdateMeDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Enter your full name' })
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  @Matches(/^$|^\+?[\d\s()-]{7,}$/, {
    message: 'Enter a valid phone number, e.g. 0803 123 4567',
  })
  phone?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) jobTitle?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) branch?: string;

  @IsOptional()
  @IsInt({ message: 'Target must be a whole naira amount' })
  @Min(1_000_000, { message: 'Target must be at least ₦1,000,000' })
  @Max(1_000_000_000_000, { message: 'Target looks too large' })
  targetAmount?: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Pick a valid start date' })
  targetStartDate?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Pick a valid end date' })
  targetEndDate?: string | null;

  @IsOptional() @IsTimeZone() timezone?: string;

  @IsOptional() @IsBoolean() digestEmail?: boolean;
  @IsOptional() @IsBoolean() digestPush?: boolean;

  @IsOptional()
  @IsInt({ message: 'Pick an hour between 5am and 11am' })
  @Min(5, { message: 'Pick an hour between 5am and 11am' })
  @Max(11, { message: 'Pick an hour between 5am and 11am' })
  digestHour?: number;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, v) => v !== '')
  @IsEmail({}, { message: 'Enter a valid email address for your manager' })
  managerEmail?: string;

  @IsOptional() @IsBoolean() weeklyReport?: boolean;

  @IsOptional()
  @IsInt({ message: 'Daily goal must be a whole number' })
  @Min(1, { message: 'Daily goal must be at least 1' })
  @Max(200, { message: 'Daily goal must be 200 or less' })
  dailyGoal?: number;
}

// ~300 KB of base64; the browser resizes to 256px first, so real avatars are ~20 KB.
const MAX_AVATAR = 400_000;

class AvatarDto {
  @IsString()
  @MaxLength(MAX_AVATAR, {
    message: 'That image is too large. Try a smaller one.',
  })
  @Matches(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, {
    message: 'Upload a JPG, PNG or WebP image',
  })
  dataUrl: string;
}

const view = (u: User) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  phone: u.phone,
  jobTitle: u.jobTitle,
  branch: u.branch,
  avatarUrl: u.avatarUrl,
  timezone: u.timezone,
  dailyGoal: u.dailyGoal,
  targetAmount: Number(u.targetAmount),
  targetStartDate: u.targetStartDate.toISOString().slice(0, 10),
  targetEndDate: u.targetEndDate?.toISOString().slice(0, 10) ?? null,
  digestEmail: u.digestEmail,
  digestPush: u.digestPush,
  digestHour: u.digestHour,
  managerEmail: u.managerEmail,
  weeklyReport: u.weeklyReport,
  twoFactorEnabled: u.twoFactorEnabled,
  teamId: u.teamId,
  teamRole: u.teamRole,
  createdAt: u.createdAt.toISOString(),
});

const blankToNull = (v: string | undefined) =>
  v === undefined ? undefined : v || null;

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
        name: dto.name,
        phone: blankToNull(dto.phone),
        jobTitle: blankToNull(dto.jobTitle),
        branch: blankToNull(dto.branch),
        timezone: dto.timezone,
        dailyGoal: dto.dailyGoal,
        targetAmount:
          dto.targetAmount === undefined ? undefined : BigInt(dto.targetAmount),
        targetStartDate: dto.targetStartDate
          ? toDate(dto.targetStartDate)
          : undefined,
        targetEndDate:
          dto.targetEndDate === undefined
            ? undefined
            : dto.targetEndDate
              ? toDate(dto.targetEndDate)
              : null,
        digestEmail: dto.digestEmail,
        digestPush: dto.digestPush,
        digestHour: dto.digestHour,
        managerEmail: blankToNull(dto.managerEmail),
        weeklyReport: dto.weeklyReport,
      },
    });
    return view(u);
  }

  @Put('me/avatar')
  async setAvatar(@CurrentUser() user: AuthUser, @Body() dto: AvatarDto) {
    return view(
      await this.prisma.user.update({
        where: { id: user.sub },
        data: { avatarUrl: dto.dataUrl },
      }),
    );
  }

  @Delete('me/avatar')
  async removeAvatar(@CurrentUser() user: AuthUser) {
    return view(
      await this.prisma.user.update({
        where: { id: user.sub },
        data: { avatarUrl: null },
      }),
    );
  }
}

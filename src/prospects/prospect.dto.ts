import { ActivityType, Stage, Tier } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Every field is optional so the same class serves updates; null clears a value.
export class UpdateProspectDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name?: string;

  @IsOptional() @IsString() @MaxLength(160) company?: string | null;
  @IsOptional() @IsString() @MaxLength(60) group?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @IsEmail()
  email?: string | null;

  @IsOptional() @IsEnum(Tier) tier?: Tier | null;
  @IsOptional() @IsEnum(Stage) stage?: Stage;

  @IsOptional() @IsInt() @Min(0) potential?: number | null;
  @IsOptional() @IsInt() @Min(0) funded?: number | null;

  @IsOptional() @IsString() @MaxLength(200) nextAction?: string | null;

  @IsOptional()
  @Matches(YMD, { message: 'nextDate must be YYYY-MM-DD' })
  nextDate?: string | null;

  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}

export class CreateProspectDto extends UpdateProspectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  declare name: string;
}

export class ListProspectsQuery {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsEnum(Stage) stage?: Stage;
  @IsOptional() @IsIn(['A', 'B', 'C', 'NONE']) tier?: string;
  @IsOptional() @IsString() group?: string;
}

export const TOUCH_TYPES = Object.values(ActivityType).filter(
  (t) => t !== ActivityType.STAGE_CHANGE,
);

export class LogActivityDto {
  @IsIn(TOUCH_TYPES)
  type: ActivityType;

  @IsOptional() @IsString() @MaxLength(1000) note?: string;

  /** Explicit follow-up; when omitted the tier cadence decides. */
  @IsOptional()
  @Matches(YMD, { message: 'nextDate must be YYYY-MM-DD' })
  nextDate?: string;

  /** Replaces the next action; empty string clears it. */
  @IsOptional() @IsString() @MaxLength(200) nextAction?: string;
}

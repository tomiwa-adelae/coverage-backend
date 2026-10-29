import {
  ActivityType,
  CallOutcome,
  ConsentMethod,
  Product,
  Source,
  Stage,
  Tier,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const PHONE = /^\+?[\d\s()-]{7,}$/;

// Every field is optional so the same class serves updates; null clears a value.
export class UpdateProspectDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Enter the prospect’s name' })
  @MaxLength(160)
  name?: string;

  @IsOptional() @IsString() @MaxLength(160) company?: string | null;
  @IsOptional() @IsString() @MaxLength(60) group?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => !!v)
  @IsString()
  @MaxLength(40)
  @Matches(PHONE, {
    message: 'Enter a valid phone number, e.g. 0803 123 4567',
  })
  phone?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @IsEmail({}, { message: 'Enter a valid email address' })
  email?: string | null;

  @IsOptional() @IsEnum(Tier) tier?: Tier | null;
  @IsOptional() @IsEnum(Stage) stage?: Stage;

  @IsOptional()
  @IsInt({ message: 'Deposit potential must be a whole naira amount' })
  @Min(0, { message: 'Deposit potential can’t be negative' })
  potential?: number | null;

  @IsOptional()
  @IsInt({ message: 'Funded balance must be a whole naira amount' })
  @Min(0, { message: 'Funded balance can’t be negative' })
  funded?: number | null;

  @IsOptional() @IsString() @MaxLength(200) nextAction?: string | null;

  @IsOptional()
  @Matches(YMD, { message: 'Pick a valid follow-up date' })
  nextDate?: string | null;

  /** Local time on nextDate; null makes it an all-day follow-up. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(HHMM, { message: 'Pick a valid time' })
  nextTime?: string | null;

  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'Keep the reason under 300 characters' })
  outcomeReason?: string | null;

  @IsOptional()
  @IsEnum(Source, { message: 'Pick where they came from' })
  source?: Source | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsEnum(Product, { each: true, message: 'Pick products from the list' })
  wantsProducts?: Product[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsEnum(Product, { each: true, message: 'Pick products from the list' })
  holdsProducts?: Product[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('4', { message: 'Pick who referred them from your prospects' })
  referredById?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => !!v)
  @Matches(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    message: 'Pick a valid birthday',
  })
  birthday?: string | null;

  @IsOptional() @IsString() @MaxLength(60) area?: string | null;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsLatitude({ message: 'That location isn’t valid' })
  latitude?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsLongitude({ message: 'That location isn’t valid' })
  longitude?: number | null;

  @IsOptional()
  @IsEnum(ConsentMethod, { message: 'Pick how they gave consent' })
  consentMethod?: ConsentMethod | null;

  @IsOptional() @IsString() @MaxLength(300) consentNote?: string | null;

  /** Starts (or with null, stops) a follow-up cadence from today. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('4', { message: 'Pick a follow-up plan from the list' })
  cadenceId?: string | null;
}

export class CreateProspectDto extends UpdateProspectDto {
  @IsString()
  @IsNotEmpty({ message: 'Enter the prospect’s name' })
  @MaxLength(160)
  declare name: string;
}

export class ImportProspectsDto {
  @IsArray()
  @ArrayMaxSize(2000, { message: 'Import up to 2,000 rows at a time' })
  @ValidateNested({ each: true })
  @Type(() => CreateProspectDto)
  rows: CreateProspectDto[];
}

export class ListProspectsQuery {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsEnum(Stage) stage?: Stage;
  @IsOptional() @IsIn(['A', 'B', 'C', 'NONE']) tier?: string;
  @IsOptional() @IsString() group?: string;
  @IsOptional() @IsString() area?: string;
}

export const TOUCH_TYPES = Object.values(ActivityType).filter(
  (t) => t !== ActivityType.STAGE_CHANGE,
);

export class LogActivityDto {
  @IsIn(TOUCH_TYPES, { message: 'Choose how you reached them' })
  type: ActivityType;

  @IsOptional()
  @IsEnum(CallOutcome, { message: 'Pick how it went' })
  outcome?: CallOutcome;

  @IsOptional() @IsString() @MaxLength(1000) note?: string;

  /** Explicit follow-up; when omitted the cadence or tier decides. */
  @IsOptional()
  @Matches(YMD, { message: 'Pick a valid follow-up date' })
  nextDate?: string;

  /** Time on nextDate; only used together with nextDate. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(HHMM, { message: 'Pick a valid time' })
  nextTime?: string | null;

  /** Replaces the next action; empty string clears it. */
  @IsOptional() @IsString() @MaxLength(200) nextAction?: string;

  /**
   * Made on the phone, so a log saved offline and sent twice (a dropped
   * connection) is only recorded once.
   */
  @IsOptional() @IsUUID('4') clientId?: string;
}

export class ReferralAskedDto {
  @IsBoolean() asked: boolean;
}

export class SendEmailDto {
  @IsString()
  @IsNotEmpty({ message: 'Add a subject' })
  @MaxLength(200)
  subject: string;

  @IsString()
  @IsNotEmpty({ message: 'Write a message' })
  @MaxLength(10_000)
  body: string;
}

export class SendSmsDto {
  @IsString()
  @IsNotEmpty({ message: 'Write a message' })
  @MaxLength(918, { message: 'Keep SMS messages under 918 characters' })
  body: string;
}

export class BalanceDto {
  @Matches(YM, { message: 'Pick a valid month' })
  month: string;

  @IsInt({ message: 'Balance must be a whole naira amount' })
  @Min(0, { message: 'Balance can’t be negative' })
  @Max(1_000_000_000_000, { message: 'That balance looks too large' })
  amount: number;
}

class BalanceRow {
  @IsUUID('4') prospectId: string;

  @ValidateIf((_, v) => v !== null)
  @IsInt({ message: 'Balance must be a whole naira amount' })
  @Min(0, { message: 'Balance can’t be negative' })
  @Max(1_000_000_000_000, { message: 'That balance looks too large' })
  amount: number | null;
}

/** One month's balances for several customers; null removes an entry. */
export class BalanceBatchDto {
  @Matches(YM, { message: 'Pick a valid month' })
  month: string;

  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => BalanceRow)
  rows: BalanceRow[];
}

export class MonthQuery {
  @IsOptional()
  @Matches(YM, { message: 'Pick a valid month' })
  month?: string;
}

import {
  ActivityType,
  CallOutcome,
  Product,
  Stage,
  Tier,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { HHMM, PHONE, TOUCH_TYPES } from '../prospects/prospect.dto';
import { AUDIO_TYPES } from './transcribe.service';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Start a debrief: with `text` it's typed and read straight away. */
export class CreateDebriefDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Type or record your debrief first' })
  @MaxLength(30_000, {
    message: 'That’s too long for one debrief. Split it into two.',
  })
  text?: string;
}

export class ProcessDebriefDto {
  @IsInt() @Min(1) @Max(20) parts: number;
  @IsInt() @Min(1) @Max(26_214_400) bytes: number;

  @IsString()
  @Matches(new RegExp(`^(${AUDIO_TYPES.join('|')})(;.*)?$`), {
    message: 'That recording format isn’t supported',
  })
  mime: string;
}

export class RereadDebriefDto {
  @IsString()
  @IsNotEmpty({ message: 'The transcript is empty' })
  @MaxLength(30_000)
  transcript: string;
}

class NewProspectDto {
  @IsString()
  @IsNotEmpty({ message: 'Enter the new prospect’s name' })
  @MaxLength(160)
  name: string;

  @IsOptional() @IsString() @MaxLength(160) company?: string;

  @IsOptional()
  @Matches(PHONE, { message: 'Enter a valid phone number, e.g. 0803 123 4567' })
  phone?: string;

  @IsOptional() @IsString() @MaxLength(60) area?: string;
}

class ContactDto {
  @IsIn(TOUCH_TYPES, { message: 'Choose how you reached them' })
  type: ActivityType;

  @IsOptional() @IsEnum(CallOutcome) outcome?: CallOutcome;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @Matches(YMD, { message: 'Pick a valid contact date' }) date: string;
}

export class ApplyTaskDto {
  @IsString()
  @IsNotEmpty({ message: 'Say what needs doing' })
  @MaxLength(200)
  title: string;

  @IsOptional()
  @Matches(YMD, { message: 'Pick a valid date' })
  dueDate?: string;

  @IsOptional()
  @Matches(HHMM, { message: 'Pick a valid time' })
  dueTime?: string;
}

/** One reviewed person: either an existing prospect or a new one. */
export class ApplyItemDto {
  @IsOptional() @IsUUID('4') prospectId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NewProspectDto)
  newProspect?: NewProspectDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContactDto)
  contact?: ContactDto;

  /** Kept on the prospect's notes when nothing was logged as a contact. */
  @IsOptional() @IsString() @MaxLength(1000) note?: string;

  @IsOptional() @IsEnum(Stage) stage?: Stage;
  @IsOptional() @IsString() @MaxLength(300) outcomeReason?: string;

  @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000_000) potential?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000_000) funded?: number;
  @IsOptional() @IsEnum(Tier) tier?: Tier;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsEnum(Product, { each: true })
  wantsProducts?: Product[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsEnum(Product, { each: true })
  holdsProducts?: Product[];

  @IsOptional() @IsUUID('4') referredById?: string;

  @IsOptional() @IsString() @MaxLength(200) nextAction?: string;
  @IsOptional()
  @Matches(YMD, { message: 'Pick a valid date' })
  nextDate?: string;
  @IsOptional()
  @Matches(HHMM, { message: 'Pick a valid time' })
  nextTime?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ApplyTaskDto)
  tasks?: ApplyTaskDto[];
}

export class ApplyDebriefDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ApplyItemDto)
  items: ApplyItemDto[];

  /** General to-dos, not about anyone. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ApplyTaskDto)
  tasks?: ApplyTaskDto[];
}

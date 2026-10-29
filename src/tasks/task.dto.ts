import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Repeat } from '@prisma/client';
import { HHMM } from '../prospects/prospect.dto';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Say what needs doing' })
  @MaxLength(200, { message: 'Keep it under 200 characters' })
  title?: string;

  /** null clears it (an "anytime" task). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(YMD, { message: 'Pick a valid date' })
  dueDate?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(HHMM, { message: 'Pick a valid time' })
  dueTime?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsEnum(Repeat, { message: 'Pick how often it repeats' })
  repeat?: Repeat | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all', { message: 'Pick a prospect' })
  prospectId?: string | null;

  @IsOptional() @IsBoolean() done?: boolean;
}

export class CreateTaskDto extends UpdateTaskDto {
  @IsString()
  @IsNotEmpty({ message: 'Say what needs doing' })
  @MaxLength(200, { message: 'Keep it under 200 characters' })
  declare title: string;

  /** Made on the phone so a to-do added offline isn't saved twice. */
  @IsOptional() @IsUUID('4') id?: string;

  /** What suggested it, e.g. "cross-sell:<prospect>:POS", so it isn't suggested again. */
  @IsOptional()
  @Matches(/^[a-z-]+:[\w:-]{1,120}$/)
  source?: string;
}

export class ListTasksQuery {
  @IsOptional() @IsIn(['open', 'done']) status?: 'open' | 'done';
  @IsOptional() @IsUUID() prospectId?: string;
}

export class ChecklistDto {
  @IsIn(['INDIVIDUAL', 'BUSINESS'], { message: 'Pick a checklist' })
  kind: 'INDIVIDUAL' | 'BUSINESS';
}

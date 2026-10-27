import { ActivityType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TOUCH_TYPES } from '../prospects/prospect.dto';
import { CadenceStep } from './cadences';

export class StepDto implements CadenceStep {
  @IsInt({ message: 'Day must be a whole number' })
  @Min(0, { message: 'Day can’t be negative' })
  @Max(365, { message: 'Keep steps within a year' })
  day: number;

  @IsIn(TOUCH_TYPES, { message: 'Choose how to reach them' })
  type: ActivityType;

  @IsString()
  @IsNotEmpty({ message: 'Describe the step' })
  @MaxLength(200)
  action: string;
}

export class UpdateCadenceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Give the plan a name' })
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Add at least one step' })
  @ArrayMaxSize(20, { message: 'Keep plans to 20 steps or fewer' })
  @ValidateNested({ each: true })
  @Type(() => StepDto)
  steps?: StepDto[];
}

export class CadenceDto extends UpdateCadenceDto {
  @IsString()
  @IsNotEmpty({ message: 'Give the plan a name' })
  @MaxLength(80)
  declare name: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Add at least one step' })
  @ArrayMaxSize(20, { message: 'Keep plans to 20 steps or fewer' })
  @ValidateNested({ each: true })
  @Type(() => StepDto)
  declare steps: StepDto[];
}

import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateTemplateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(2000) body?: string;
}

export class TemplateDto extends UpdateTemplateDto {
  @IsString() @IsNotEmpty() @MaxLength(80) declare name: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) declare body: string;
}

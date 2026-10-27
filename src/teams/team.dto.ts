import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateTeamDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Give the team a name' })
  @MaxLength(80, { message: 'Keep the name under 80 characters' })
  name: string;
}

export class JoinTeamDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.replace(/[\s-]/g, '').toUpperCase()
      : value,
  )
  @IsString()
  @Matches(/^[A-Z2-9]{8}$/, {
    message: 'Invite codes are 8 letters and numbers, e.g. K7QM-4XPA',
  })
  code: string;
}

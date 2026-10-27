import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const normaliseEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const PASSWORD_HINT =
  'Password must include at least one letter and one number';

export class RegisterDto {
  @IsString()
  @IsNotEmpty({ message: 'Enter your full name' })
  @MaxLength(120)
  name: string;

  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: PASSWORD_HINT })
  password: string;
}

export class LoginDto {
  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'Enter your password' })
  password: string;
}

export class ForgotPasswordDto {
  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'This reset link is incomplete. Request a new one.' })
  @MaxLength(200)
  token: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: PASSWORD_HINT })
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Enter your current password' })
  currentPassword: string;

  @IsString()
  @MinLength(8, { message: 'New password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(PASSWORD_RULE, {
    message: 'New password must include at least one letter and one number',
  })
  newPassword: string;
}

export class TwoFactorLoginDto {
  @IsString()
  @IsNotEmpty({ message: 'Your sign-in took too long. Start again.' })
  @MaxLength(2000)
  ticket: string;

  @IsString()
  @IsNotEmpty({ message: 'Enter the 6-digit code or a backup code' })
  @MaxLength(20)
  code: string;
}

export class TwoFactorCodeDto {
  @IsString()
  @Matches(/^\s*\d{3}\s?\d{3}\s*$/, {
    message: 'Enter the 6-digit code from your authenticator app',
  })
  code: string;
}

export class PasswordConfirmDto {
  @IsString()
  @IsNotEmpty({ message: 'Enter your password' })
  password: string;
}

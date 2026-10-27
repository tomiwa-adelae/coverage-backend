import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import type { Channel } from './ai.service';

export class DraftDto {
  @IsIn(['WHATSAPP', 'EMAIL', 'SMS'], {
    message: 'Pick WhatsApp, email or SMS',
  })
  channel: Channel;

  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'Keep the goal under 300 characters' })
  goal?: string;
}

export class NoteDto {
  @IsString()
  @IsNotEmpty({ message: 'Record or type a note first' })
  @MaxLength(5000, {
    message: 'That note is too long. Keep it under 5,000 characters',
  })
  text: string;

  @IsOptional() @IsUUID('4') prospectId?: string;
}

export class CardDto {
  @IsString()
  @MaxLength(1_500_000, {
    message: 'That photo is too large. Try a smaller one.',
  })
  @Matches(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, {
    message: 'Upload a JPG, PNG or WebP photo of the card',
  })
  image: string;
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators';
import type { AuthUser } from '../common/decorators';
import { AiService } from './ai.service';
import { CardDto, DraftDto, NoteDto } from './ai.dto';

@Controller('ai')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class AiController {
  constructor(private ai: AiService) {}

  @Get('status')
  status() {
    return { enabled: this.ai.configured };
  }

  @Post('prospects/:id/brief')
  @HttpCode(200)
  brief(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.brief(user.sub, id);
  }

  @Post('prospects/:id/draft')
  @HttpCode(200)
  draft(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DraftDto,
  ) {
    return this.ai.draft(user.sub, id, dto.channel, dto.goal?.trim());
  }

  @Post('notes')
  @HttpCode(200)
  note(@CurrentUser() user: AuthUser, @Body() dto: NoteDto) {
    return this.ai.tidyNote(user.sub, dto.text.trim(), dto.prospectId);
  }

  @Post('business-card')
  @HttpCode(200)
  card(@Body() dto: CardDto) {
    return this.ai.scanCard(dto.image);
  }
}

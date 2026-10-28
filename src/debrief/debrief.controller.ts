import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators';
import type { AuthUser } from '../common/decorators';
import { DebriefService } from './debrief.service';
import {
  ApplyDebriefDto,
  CreateDebriefDto,
  ProcessDebriefDto,
  RereadDebriefDto,
} from './debrief.dto';

@Controller('debriefs')
export class DebriefController {
  constructor(private debriefs: DebriefService) {}

  /** Whether voice and the assistant are switched on for this server. */
  @Get('status')
  status() {
    return this.debriefs.status();
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.debriefs.list(user.sub);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDebriefDto) {
    return this.debriefs.create(user.sub, dto);
  }

  /** One slice of the recording, sent as raw audio bytes. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Put(':id/parts/:index')
  @HttpCode(204)
  async part(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Req() req: Request,
  ) {
    await this.debriefs.putPart(
      user.sub,
      id,
      Math.max(0, Math.min(19, index)),
      req.body,
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/process')
  @HttpCode(202)
  process(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProcessDebriefDto,
  ) {
    return this.debriefs.process(user.sub, id, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.debriefs.get(user.sub, id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/reread')
  @HttpCode(202)
  reread(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RereadDebriefDto,
  ) {
    return this.debriefs.reread(user.sub, id, dto.transcript);
  }

  @Post(':id/apply')
  @HttpCode(200)
  apply(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyDebriefDto,
  ) {
    return this.debriefs.apply(user.sub, id, dto);
  }

  @Post(':id/undo')
  @HttpCode(200)
  undo(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.debriefs.undo(user.sub, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.debriefs.remove(user.sub, id);
  }
}

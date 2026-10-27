import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Client, CurrentUser } from '../common/decorators';
import type { AuthUser, ClientInfo } from '../common/decorators';
import { CreateTeamDto, JoinTeamDto } from './team.dto';
import { TeamsService } from './teams.service';

@Controller('teams')
export class TeamsController {
  constructor(private teams: TeamsService) {}

  @Get('mine')
  async mine(@CurrentUser() user: AuthUser) {
    return { team: await this.teams.mine(user.sub) };
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTeamDto) {
    return this.teams.create(user.sub, dto.name);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('join')
  @HttpCode(200)
  join(
    @CurrentUser() user: AuthUser,
    @Body() dto: JoinTeamDto,
    @Client() client: ClientInfo,
  ) {
    return this.teams.join(user.sub, dto.code, client);
  }

  @Post('leave')
  @HttpCode(204)
  leave(@CurrentUser() user: AuthUser, @Client() client: ClientInfo) {
    return this.teams.leave(user.sub, client);
  }

  @Patch('mine')
  rename(@CurrentUser() user: AuthUser, @Body() dto: CreateTeamDto) {
    return this.teams.rename(user.sub, dto.name);
  }

  @Post('invite-code')
  @HttpCode(200)
  newCode(@CurrentUser() user: AuthUser) {
    return this.teams.newInviteCode(user.sub);
  }

  @Delete('members/:id')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.teams.removeMember(user.sub, id);
  }
}

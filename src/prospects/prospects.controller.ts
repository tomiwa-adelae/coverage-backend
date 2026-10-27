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
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators';
import type { AuthUser } from '../common/decorators';
import {
  CreateProspectDto,
  ListProspectsQuery,
  LogActivityDto,
  UpdateProspectDto,
} from './prospect.dto';
import { ProspectsService } from './prospects.service';

@Controller('prospects')
export class ProspectsController {
  constructor(private prospects: ProspectsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListProspectsQuery) {
    return this.prospects.list(user.sub, query);
  }

  @Get('meta')
  async meta(@CurrentUser() user: AuthUser) {
    const [groups, stageCounts] = await Promise.all([
      this.prospects.groups(user.sub),
      this.prospects.stageCounts(user.sub),
    ]);
    return { groups, stageCounts };
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.prospects.get(user.sub, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProspectDto) {
    return this.prospects.create(user.sub, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProspectDto,
  ) {
    return this.prospects.update(user.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.prospects.remove(user.sub, id);
  }

  @Post(':id/activities')
  log(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LogActivityDto,
  ) {
    return this.prospects.logActivity(user.sub, id, dto);
  }

  @Delete(':id/activities/:activityId')
  @HttpCode(204)
  removeActivity(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('activityId', ParseUUIDPipe) activityId: string,
  ) {
    return this.prospects.deleteActivity(user.sub, id, activityId);
  }
}

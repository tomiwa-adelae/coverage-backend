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
import { CurrentUser } from '../common/decorators';
import type { AuthUser } from '../common/decorators';
import { CadenceDto, UpdateCadenceDto } from './cadence.dto';
import { CadencesService } from './cadences.service';

@Controller('cadences')
export class CadencesController {
  constructor(private cadences: CadencesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.cadences.list(user.sub);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CadenceDto) {
    return this.cadences.create(user.sub, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCadenceDto,
  ) {
    return this.cadences.update(user.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.cadences.remove(user.sub, id);
  }
}

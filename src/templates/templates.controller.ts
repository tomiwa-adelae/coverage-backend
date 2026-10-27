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
import { TemplateDto, UpdateTemplateDto } from './template.dto';
import { TemplatesService } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(private templates: TemplatesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.templates.list(user.sub);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: TemplateDto) {
    return this.templates.create(user.sub, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templates.update(user.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.templates.remove(user.sub, id);
  }
}

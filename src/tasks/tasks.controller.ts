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
  ChecklistDto,
  CreateTaskDto,
  ListTasksQuery,
  UpdateTaskDto,
} from './task.dto';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private tasks: TasksService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListTasksQuery) {
    return this.tasks.list(user.sub, q);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskDto) {
    return this.tasks.create(user.sub, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasks.update(user.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tasks.remove(user.sub, id);
  }

  /** Adds (or swaps) a prospect's account-opening document checklist. */
  @Post('checklist/:prospectId')
  checklist(
    @CurrentUser() user: AuthUser,
    @Param('prospectId', ParseUUIDPipe) prospectId: string,
    @Body() dto: ChecklistDto,
  ) {
    return this.tasks.addChecklist(user.sub, prospectId, dto.kind);
  }
}

import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators';
import type { AuthUser } from '../common/decorators';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private dashboard: DashboardService) {}

  @Get('today')
  today(@CurrentUser() user: AuthUser) {
    return this.dashboard.today(user.sub);
  }

  @Get('progress')
  progress(@CurrentUser() user: AuthUser) {
    return this.dashboard.progress(user.sub);
  }
}

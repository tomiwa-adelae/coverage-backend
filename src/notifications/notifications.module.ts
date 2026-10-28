import { Module } from '@nestjs/common';
import { DashboardModule } from '../dashboard/dashboard.module';
import { DigestService } from './digest.service';
import {
  JobsController,
  NotificationsController,
} from './notifications.controller';
import { PushService } from './push.service';
import { ReminderService } from './reminder.service';

@Module({
  imports: [DashboardModule],
  controllers: [NotificationsController, JobsController],
  providers: [PushService, DigestService, ReminderService],
  exports: [PushService],
})
export class NotificationsModule {}

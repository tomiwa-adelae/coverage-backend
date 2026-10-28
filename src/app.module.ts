import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AiModule } from './ai/ai.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CadencesModule } from './cadences/cadences.module';
import { CalendarController } from './calendar/calendar.controller';
import { DashboardModule } from './dashboard/dashboard.module';
import { DebriefModule } from './debrief/debrief.module';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProspectsModule } from './prospects/prospects.module';
import { SmsModule } from './sms/sms.module';
import { TeamsModule } from './teams/teams.module';
import { TemplatesModule } from './templates/templates.module';
import { UsersController } from './users/users.controller';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    MailModule,
    SmsModule,
    AuditModule,
    AuthModule,
    ProspectsModule,
    DashboardModule,
    TemplatesModule,
    CadencesModule,
    NotificationsModule,
    AiModule,
    TeamsModule,
    DebriefModule,
  ],
  controllers: [AppController, UsersController, CalendarController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { DashboardModule } from '../dashboard/dashboard.module';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';

@Module({
  imports: [DashboardModule],
  controllers: [TeamsController],
  providers: [TeamsService],
})
export class TeamsModule {}

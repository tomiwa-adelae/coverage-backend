import { Module } from '@nestjs/common';
import { CadencesModule } from '../cadences/cadences.module';
import { TasksModule } from '../tasks/tasks.module';
import {
  BalancesController,
  ProspectsController,
} from './prospects.controller';
import { ProspectsService } from './prospects.service';

@Module({
  imports: [CadencesModule, TasksModule],
  controllers: [ProspectsController, BalancesController],
  providers: [ProspectsService],
  exports: [ProspectsService],
})
export class ProspectsModule {}

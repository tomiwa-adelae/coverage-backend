import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ProspectsModule } from '../prospects/prospects.module';
import { DebriefController } from './debrief.controller';
import { DebriefService } from './debrief.service';
import { TranscribeService } from './transcribe.service';

@Module({
  imports: [AiModule, ProspectsModule],
  controllers: [DebriefController],
  providers: [DebriefService, TranscribeService],
})
export class DebriefModule {}

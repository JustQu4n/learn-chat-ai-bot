import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversation/conversation.module';
import { PracticeSchedulerService } from './practice-scheduler.service';

@Module({
  imports: [ConversationModule],
  providers: [PracticeSchedulerService],
  exports: [PracticeSchedulerService],
})
export class SchedulerModule {}

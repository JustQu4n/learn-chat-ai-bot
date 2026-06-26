import { Module } from '@nestjs/common';
import { MessagingModule } from '../telegram/messaging.module';
import { ConversationService } from './conversation.service';

@Module({
  imports: [MessagingModule],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}

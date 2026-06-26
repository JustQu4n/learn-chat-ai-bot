import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversation/conversation.module';
import { MessagingModule } from './messaging.module';
import { TelegramUpdateRouter } from './telegram.update-router';
import { TelegramWebhookController } from './telegram.webhook.controller';

@Module({
  imports: [MessagingModule, ConversationModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramUpdateRouter],
})
export class TelegramModule {}

import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { ConfigModule } from './config/config.module';
import { ConversationModule } from './conversation/conversation.module';
import { HealthController } from './health.controller';
import { PersistenceModule } from './persistence/persistence.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [ConfigModule, PersistenceModule, AiModule, ConversationModule, TelegramModule],
  controllers: [HealthController],
})
export class AppModule {}

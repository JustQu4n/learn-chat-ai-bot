import { Global, Module } from '@nestjs/common';
import { TelegramGateway } from './telegram.gateway';

@Global()
@Module({
  providers: [TelegramGateway],
  exports: [TelegramGateway],
})
export class MessagingModule {}

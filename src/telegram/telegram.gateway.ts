import { Injectable } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { AppConfig } from '../config/app-config.service';

@Injectable()
export class TelegramGateway {
  private readonly bot: Telegraf;

  constructor(config: AppConfig) {
    this.bot = new Telegraf(config.telegramBotToken);
  }

  async sendText(chatId: bigint, text: string): Promise<{ messageId: number }> {
    const message = await this.bot.telegram.sendMessage(chatId.toString(), text);
    return { messageId: message.message_id };
  }
}

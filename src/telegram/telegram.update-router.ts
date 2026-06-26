import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';

interface TelegramUser {
  id: number;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  from?: TelegramUser;
  chat: { id: number };
  reply_to_message?: { message_id: number };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

@Injectable()
export class TelegramUpdateRouter {
  private readonly logger = new Logger(TelegramUpdateRouter.name);

  constructor(private readonly conversation: ConversationService) {}

  async handle(update: TelegramUpdate) {
    const message = update.message;
    const telegramId = message?.from?.id;
    const claimed = await this.conversation.claimTelegramUpdate(
      update.update_id,
      telegramId ? BigInt(telegramId) : undefined,
    );
    if (!claimed) return;

    try {
      if (message?.from) await this.routeMessage(message);
      await this.conversation.markTelegramUpdate(update.update_id, true);
    } catch (error) {
      this.logger.error(`Telegram update ${update.update_id} failed`);
      await this.conversation.markTelegramUpdate(update.update_id, false);
      throw error;
    }
  }

  private async routeMessage(message: TelegramMessage) {
    const telegramId = BigInt(message.from!.id);
    const chatId = BigInt(message.chat.id);
    const text = message.text?.trim();
    if (!text) {
      await this.conversation.registerUser(telegramId, message.from!.username);
      return;
    }
    if (text.startsWith('/')) {
      await this.routeCommand(telegramId, chatId, message.from!.username, text);
      return;
    }
    await this.conversation.receiveReply({
      telegramId,
      chatId,
      text,
      replyToMessageId: message.reply_to_message?.message_id,
    });
  }

  private async routeCommand(
    telegramId: bigint,
    chatId: bigint,
    username: string | undefined,
    text: string,
  ) {
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();
    await this.conversation.registerUser(telegramId, username);
    switch (command) {
      case '/start':
        await this.conversation.startPracticeWelcome(telegramId, chatId);
        return;
      case '/help':
        await this.conversation.showHelp(chatId);
        return;
      case '/practice':
        await this.conversation.startPractice({
          telegramId,
          chatId,
          requestedTopic: args[0]?.toLowerCase(),
        });
        return;
      case '/skip':
      case '/cancel':
        await this.conversation.skipPractice(telegramId, chatId);
        return;
      case '/retry':
        await this.conversation.retryEvaluation(telegramId, chatId);
        return;
      case '/history':
        await this.conversation.showHistory(telegramId, chatId, args[0]);
        return;
      default:
        await this.conversation.showUnknownCommand(chatId);
    }
  }
}

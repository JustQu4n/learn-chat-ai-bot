import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../config/app-config.service';
import { TelegramUpdateRouter } from './telegram.update-router';

@Controller('webhooks/telegram')
export class TelegramWebhookController {
  constructor(
    private readonly config: AppConfig,
    private readonly router: TelegramUpdateRouter,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: { update_id?: number },
  ) {
    if (!this.isExpectedSecret(secret) || !Number.isInteger(update.update_id)) {
      throw new UnauthorizedException();
    }
    await this.router.handle(update as { update_id: number });
    return { ok: true };
  }

  private isExpectedSecret(received: string | undefined) {
    if (!received) return false;
    const expectedBuffer = Buffer.from(this.config.telegramWebhookSecret);
    const receivedBuffer = Buffer.from(received);
    return (
      expectedBuffer.length === receivedBuffer.length &&
      timingSafeEqual(expectedBuffer, receivedBuffer)
    );
  }
}

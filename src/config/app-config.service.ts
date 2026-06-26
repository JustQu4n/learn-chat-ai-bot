import { Injectable } from '@nestjs/common';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function port(): number {
  const value = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('PORT must be a positive integer');
  }
  return value;
}

@Injectable()
export class AppConfig {
  readonly nodeEnv = process.env.NODE_ENV ?? 'development';
  readonly port = port();
  readonly databaseUrl = required('DATABASE_URL');
  readonly telegramBotToken = required('TELEGRAM_BOT_TOKEN');
  readonly telegramWebhookSecret = required('TELEGRAM_WEBHOOK_SECRET');
  readonly geminiApiKey = required('GEMINI_API_KEY');
  readonly geminiModel = required('GEMINI_MODEL');
  readonly defaultTimezone = process.env.DEFAULT_TIMEZONE?.trim() || 'Asia/Ho_Chi_Minh';
}

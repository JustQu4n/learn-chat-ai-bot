import { Injectable } from '@nestjs/common';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

@Injectable()
export class AppConfig {
  readonly nodeEnv = process.env.NODE_ENV ?? 'development';
  readonly port = positiveInteger('PORT', 3000);
  readonly databaseUrl = required('DATABASE_URL');
  readonly telegramBotToken = required('TELEGRAM_BOT_TOKEN');
  readonly telegramWebhookSecret = required('TELEGRAM_WEBHOOK_SECRET');
  readonly openAiApiKey = required('OPENAI_API_KEY');
  readonly openAiModel = required('OPENAI_MODEL');
  readonly openAiTimeoutMs = positiveInteger('OPENAI_TIMEOUT_MS', 12_000);
  readonly defaultTimezone = process.env.DEFAULT_TIMEZONE?.trim() || 'Asia/Ho_Chi_Minh';
}

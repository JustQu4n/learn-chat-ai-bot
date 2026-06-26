CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "PracticeLevel" AS ENUM ('INTERN', 'FRESHER', 'JUNIOR');
CREATE TYPE "PracticeSource" AS ENUM ('MANUAL', 'SCHEDULED');
CREATE TYPE "PracticeSessionStatus" AS ENUM ('GENERATING', 'WAITING_REPLY', 'EVALUATING', 'COMPLETED', 'SKIPPED', 'GENERATION_FAILED', 'EVALUATION_FAILED');
CREATE TYPE "TelegramUpdateStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

CREATE TABLE "users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "telegram_id" BIGINT NOT NULL,
  "telegram_username" VARCHAR(255),
  "level" "PracticeLevel" NOT NULL DEFAULT 'JUNIOR',
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

CREATE TABLE "practice_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "source" "PracticeSource" NOT NULL DEFAULT 'MANUAL',
  "status" "PracticeSessionStatus" NOT NULL,
  "topic" VARCHAR(64) NOT NULL,
  "client_tone" VARCHAR(32),
  "client_message" TEXT,
  "telegram_chat_id" BIGINT,
  "telegram_client_message_id" BIGINT,
  "user_reply" TEXT,
  "fallback_bound_reply" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reply_received_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "practice_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "practice_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "practice_sessions_user_id_created_at_idx" ON "practice_sessions"("user_id", "created_at");
CREATE INDEX "practice_sessions_user_id_status_idx" ON "practice_sessions"("user_id", "status");
CREATE UNIQUE INDEX "practice_sessions_telegram_chat_id_telegram_client_message_id_key" ON "practice_sessions"("telegram_chat_id", "telegram_client_message_id");
CREATE UNIQUE INDEX "practice_sessions_one_active_per_user" ON "practice_sessions"("user_id") WHERE "status" IN ('GENERATING', 'WAITING_REPLY', 'EVALUATING');

CREATE TABLE "evaluations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "practice_session_id" UUID NOT NULL,
  "overall_score" DECIMAL(3,1) NOT NULL CHECK ("overall_score" >= 0 AND "overall_score" <= 10),
  "criteria" JSONB NOT NULL,
  "feedback" JSONB NOT NULL,
  "better_reply" TEXT NOT NULL,
  "vietnamese_explanation" TEXT NOT NULL,
  "model" VARCHAR(128) NOT NULL,
  "prompt_version" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evaluations_practice_session_id_key" UNIQUE ("practice_session_id"),
  CONSTRAINT "evaluations_practice_session_id_fkey" FOREIGN KEY ("practice_session_id") REFERENCES "practice_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "telegram_updates" (
  "update_id" BIGINT NOT NULL,
  "telegram_id" BIGINT,
  "processing_status" "TelegramUpdateStatus" NOT NULL DEFAULT 'RECEIVED',
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  CONSTRAINT "telegram_updates_pkey" PRIMARY KEY ("update_id")
);
CREATE INDEX "telegram_updates_telegram_id_idx" ON "telegram_updates"("telegram_id");

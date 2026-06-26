CREATE TYPE "MessageJobStatus" AS ENUM ('PLANNED', 'QUEUED', 'SENT', 'SKIPPED', 'FAILED', 'CANCELLED');

ALTER TABLE "users"
  ADD COLUMN "last_chat_id" BIGINT,
  ADD COLUMN "preferred_topics" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "scheduler_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "schedule_daily_target" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "quiet_hours_start" VARCHAR(5),
  ADD COLUMN "quiet_hours_end" VARCHAR(5),
  ADD COLUMN "project_context" TEXT;

CREATE TABLE "message_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "local_date" DATE NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "topic" VARCHAR(64) NOT NULL,
  "tone" VARCHAR(32) NOT NULL,
  "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
  "status" "MessageJobStatus" NOT NULL DEFAULT 'PLANNED',
  "bullmq_job_id" VARCHAR(255),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "message_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "message_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "message_jobs_user_id_local_date_ordinal_key" UNIQUE ("user_id", "local_date", "ordinal"),
  CONSTRAINT "message_jobs_bullmq_job_id_key" UNIQUE ("bullmq_job_id")
);

CREATE INDEX "message_jobs_status_scheduled_at_idx" ON "message_jobs"("status", "scheduled_at");

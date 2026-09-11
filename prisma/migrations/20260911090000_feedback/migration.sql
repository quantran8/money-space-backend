-- "Báo lỗi / Góp ý" — one person's message to whoever builds this.
--
-- Stored in Postgres and nowhere else. There is no email, no webhook and no
-- read endpoint: submissions are read in the Supabase dashboard. That is the
-- whole delivery mechanism and a deliberate MVP choice — a notification channel
-- is infrastructure to run, and the first hundred reports do not need one.
--
-- Two shape decisions worth the ink:
--
-- 1. NOT household-scoped. A report is written by a person, not by a space, and
--    the report that matters most is the one filed from a state where there is
--    no household yet — onboarding, or a gate that keeps redirecting. Under a
--    `households/:id/feedback` path those users have no URL to post to at all.
--    `household_id` is therefore a CONTEXT hint with no foreign key: a report
--    about a space that was then deleted must still insert, and must still be
--    there afterwards.
--
-- 2. `context` is jsonb, not columns. Route, app version, platform and user
--    agent are the CLIENT's vocabulary and will drift as the apps change; a
--    column per field means a migration every time the mobile app learns to
--    report one more thing about itself. Nothing queries inside this bag, so
--    the usual argument for columns (indexable, typed) buys nothing here.
--
-- Append-only, like audit_logs: no deleted_at, no updated_at. A submitted
-- report is a historical fact and nothing in the app can edit or remove one.
--
-- See memory/feedback.md.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feedback_type') THEN
    CREATE TYPE "feedback_type" AS ENUM ('bug', 'idea', 'other');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "feedback" (
  "id"           UUID            NOT NULL,
  -- The reporter, resolved from the bearer token. Never read from the body.
  "user_id"      UUID            NOT NULL,
  "type"         "feedback_type" NOT NULL,
  "message"      TEXT            NOT NULL,
  -- Denormalized from the token so a row is readable in the dashboard with no
  -- join, and survives the profile being deleted.
  "email"        TEXT,
  -- No FK, on purpose. See the header.
  "household_id" UUID,
  "context"      JSONB           NOT NULL DEFAULT '{}'::jsonb,
  "created_at"   TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- The message is the whole point of the row, so an empty one is not a report.
-- Length is capped here as well as in the service: the service is what returns
-- a readable 400, this is what holds if anything else ever writes the table.
--
-- NOTE: Prisma cannot express a CHECK constraint, so `prisma db push` will NOT
-- create this. Run it by hand in the Supabase SQL editor after `npm run db:init`.
ALTER TABLE "feedback"
  DROP CONSTRAINT IF EXISTS "feedback_message_not_empty";
ALTER TABLE "feedback"
  ADD CONSTRAINT "feedback_message_not_empty"
  CHECK (length(btrim("message")) BETWEEN 1 AND 2000);

-- The only read pattern that exists: newest first, in the table editor.
CREATE INDEX IF NOT EXISTS "feedback_created_at_idx"
  ON "feedback" ("created_at" DESC);

-- Supports the per-user rate check in FeedbackService.
CREATE INDEX IF NOT EXISTS "feedback_user_id_created_at_idx"
  ON "feedback" ("user_id", "created_at" DESC);

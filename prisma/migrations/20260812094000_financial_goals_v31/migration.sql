-- v3.1 §20: `current_amount` becomes a REAL STORED column and the source of
-- truth for goal progress; `deadline` becomes `target_date`; goals gain a
-- planned monthly contribution so the projection has an input.
--
-- WHY STORED (this reverses an earlier deliberate decision, so it needs a
-- reason): progress was being derived as Σ goal_contribution money events. That
-- shows 0 for every household that arrives with savings predating the app —
-- which is most of them — and there is no honest event to invent for it.
--
-- The earlier stored column was dropped because it DRIFTED: nothing incremented
-- it on contribution and nothing reversed it on delete. That is the actual bug,
-- and it is fixed in MoneyEventsService, which now maintains this column inside
-- the SAME transaction as the goal_contribution event (create adds, update
-- applies the delta, delete reverses). The column is only trustworthy while
-- that mirror holds — do not bypass it.

-- Guarded so a retry after a partial failure is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'financial_goals'
       AND column_name = 'deadline'
  ) THEN
    ALTER TABLE "financial_goals" RENAME COLUMN "deadline" TO "target_date";
  END IF;
END $$;

ALTER TABLE "financial_goals"
  ADD COLUMN IF NOT EXISTS "current_amount" NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "current_amount_updated_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "planned_monthly_contribution" NUMERIC(14, 2);

-- Backfill from the events that were, until now, the source of truth.
--
-- This mirrors PrismaGoalsRepository.contributionTotals EXACTLY (deleted_at IS
-- NULL, event_type = 'goal_contribution') so no household's progress bar moves
-- on deploy.
--
-- Written as `SET =`, never `+=`, so re-running it (e.g. after `migrate resolve`
-- on a partial failure) is idempotent.
UPDATE "financial_goals" g
   SET "current_amount"            = c.total,
       "current_amount_updated_at" = c.last_at
  FROM (
    SELECT "financial_goal_id",
           COALESCE(SUM("amount"), 0)                  AS total,
           MAX(COALESCE("updated_at", "created_at"))   AS last_at
      FROM "money_events"
     WHERE "event_type" = 'goal_contribution'
       AND "deleted_at" IS NULL
       AND "financial_goal_id" IS NOT NULL
     GROUP BY "financial_goal_id"
  ) c
 WHERE c."financial_goal_id" = g."id";

-- New goal categories (§20). Safe as ADD VALUE: none of these values are USED
-- in this migration, so they don't hit the "unsafe use of new enum value in the
-- same transaction" rule.
ALTER TYPE "GoalCategory" ADD VALUE IF NOT EXISTS 'wedding';
ALTER TYPE "GoalCategory" ADD VALUE IF NOT EXISTS 'car';
ALTER TYPE "GoalCategory" ADD VALUE IF NOT EXISTS 'career_break';

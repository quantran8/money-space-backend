-- One kind of goal: a set of shares of real assets.
--
-- The previous migration split goals into two backing modes. `asset_backed`
-- worked; `earmark` was a stored figure floating free of any asset, and it
-- carried back every problem the split was meant to remove:
--
--   * "Money set aside from shared money" is not a separate kind of money — it
--     IS the household's `cash` / `bank_account` assets. Leaving it unanchored
--     meant nobody could answer "where is that 100tr actually sitting?".
--   * Because the figure was a bare declaration, it could exceed what the
--     household owned, which forced a `Math.min(totalAssets, …)` cap on the
--     dashboard. An asset-backed goal cannot exceed its assets by construction,
--     so with `earmark` gone the cap goes too.
--
-- After this migration a goal is exactly: a target, plus rows in
-- `goal_asset_allocations` saying how much of which asset counts towards it.
-- "Set aside 100tr from shared money" is a fixed 100tr allocation against the
-- wallet holding it.
--
-- Money still leaves a goal by being spent from its asset — progress falls on
-- the next read, because a fixed share is capped at the asset's live value.
-- There is no contribution event and no goal link on an expense any more.

-- 1. Reset the goal data.
--
-- An `earmark` goal recorded NO source asset: `20260713140000` dropped
-- `linked_asset_id`, and `20260819120000` cleared `from_asset_id` from every
-- contribution. So there is no honest way to convert a stored figure into an
-- allocation — picking the largest wallet, or spreading across wallets, would
-- invent a decision the household never made. That is the exact class of
-- fabrication the last two migrations existed to remove, so we do not do it
-- here either: the goals are cleared and re-declared against real assets.
--
-- Ordered first so the drops below cannot fail on leftover rows, and so the
-- enum rebuild in step 4 finds no `goal_contribution` rows to convert.
DELETE FROM "goal_asset_allocations";
DELETE FROM "money_events" WHERE "event_type" = 'goal_contribution';
-- Other events (an expense that named a goal) are KEPT — they are real money
-- that really moved. Only the goal link goes, since goals no longer take one.
UPDATE "money_events" SET "financial_goal_id" = NULL WHERE "financial_goal_id" IS NOT NULL;
UPDATE "cashflow_events" SET "financial_goal_id" = NULL WHERE "financial_goal_id" IS NOT NULL;
DELETE FROM "attention_items" WHERE "related_object_type" = 'financial_goal';
DELETE FROM "financial_goals";

-- 2. Drop the constraints that reference the columns going away.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_goals_current_nonneg') THEN
    ALTER TABLE "financial_goals" DROP CONSTRAINT "financial_goals_current_nonneg";
  END IF;
END $$;

-- 3. Drop the columns. `current_amount` was the earmark figure; `backing_mode`
-- distinguished the two kinds of goal that are now one kind.
ALTER TABLE "financial_goals"
  DROP COLUMN IF EXISTS "current_amount",
  DROP COLUMN IF EXISTS "current_amount_updated_at",
  DROP COLUMN IF EXISTS "backing_mode";

DROP TYPE IF EXISTS "GoalBackingMode";

-- 4. Remove `goal_contribution` from MoneyEventType.
--
-- Postgres has no `ALTER TYPE … DROP VALUE`, so the type is rebuilt. This is
-- safe here because the enum is used by exactly one column
-- (`money_events.event_type`) and step 1 deleted every row carrying the value.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'MoneyEventType' AND e.enumlabel = 'goal_contribution'
  ) THEN
    -- `money_events_amount_nonneg` compares `event_type` to a literal of the
    -- OLD type, so the column cannot change type underneath it. Drop it here and
    -- recreate it against the new type below.
    ALTER TABLE "money_events" DROP CONSTRAINT IF EXISTS "money_events_amount_nonneg";

    CREATE TYPE "MoneyEventType_new" AS ENUM (
      'expense',
      'income',
      'transfer',
      'asset_purchase',
      'asset_sale',
      'asset_update',
      'payment_paid',
      'debt_update',
      'adjustment',
      'other'
    );

    ALTER TABLE "money_events"
      ALTER COLUMN "event_type" TYPE "MoneyEventType_new"
      USING ("event_type"::text::"MoneyEventType_new");

    DROP TYPE "MoneyEventType";
    ALTER TYPE "MoneyEventType_new" RENAME TO "MoneyEventType";

    -- Same rule as before, now typed against the rebuilt enum: a revaluation's
    -- amount is a signed diff, everything else moves a non-negative amount.
    ALTER TABLE "money_events" ADD CONSTRAINT "money_events_amount_nonneg"
      CHECK ("amount" >= 0 OR "event_type" = 'asset_update'::"MoneyEventType") NOT VALID;
  END IF;
END $$;

-- 5. Freeze each goal's progress into every snapshot.
--
-- A goal's progress is derived from live asset values, so "what did this goal
-- hold in June?" cannot be recomputed later: allocations carry no history, and
-- adding an asset today would retroactively raise every past month. Recording
-- the resolved figure alongside the asset lines keeps the history honest — and
-- it is what makes "we meant to set aside 10tr this month, we managed 8tr"
-- answerable, as the difference between two month-end snapshots.
--
-- Mirrors `snapshot_asset_values`: same denormalisation (the name and target are
-- frozen too, so renaming a goal does not rewrite what a past snapshot meant),
-- same cascade from its parent snapshot.
CREATE TABLE IF NOT EXISTS "snapshot_goal_values" (
  "id" UUID NOT NULL,
  "household_id" UUID NOT NULL,
  "snapshot_id" UUID NOT NULL,
  "financial_goal_id" UUID NOT NULL,
  "goal_name" TEXT NOT NULL,
  "target_amount" DECIMAL(14,2) NOT NULL,
  "progress_amount" DECIMAL(14,2) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "snapshot_goal_values_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_goal_values_household_id_fkey') THEN
    ALTER TABLE "snapshot_goal_values"
      ADD CONSTRAINT "snapshot_goal_values_household_id_fkey"
      FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_goal_values_snapshot_id_fkey') THEN
    ALTER TABLE "snapshot_goal_values"
      ADD CONSTRAINT "snapshot_goal_values_snapshot_id_fkey"
      FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_goal_values_financial_goal_id_fkey') THEN
    ALTER TABLE "snapshot_goal_values"
      ADD CONSTRAINT "snapshot_goal_values_financial_goal_id_fkey"
      FOREIGN KEY ("financial_goal_id") REFERENCES "financial_goals"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_goal_values_progress_nonneg') THEN
    ALTER TABLE "snapshot_goal_values"
      ADD CONSTRAINT "snapshot_goal_values_progress_nonneg"
      CHECK ("progress_amount" >= 0 AND "target_amount" >= 0);
  END IF;
END $$;

-- One line per goal per snapshot: the per-day snapshot upsert rewrites today's
-- lines, and two rows for one goal on one day would double its history.
CREATE UNIQUE INDEX IF NOT EXISTS "snapshot_goal_values_snapshot_goal_key"
  ON "snapshot_goal_values" ("snapshot_id", "financial_goal_id");

-- Reading one goal's history walks its rows newest-first across snapshots.
CREATE INDEX IF NOT EXISTS "snapshot_goal_values_goal_idx"
  ON "snapshot_goal_values" ("financial_goal_id");

CREATE INDEX IF NOT EXISTS "snapshot_goal_values_household_snapshot_idx"
  ON "snapshot_goal_values" ("household_id", "snapshot_id");

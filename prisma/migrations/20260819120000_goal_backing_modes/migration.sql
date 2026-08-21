-- Goal backing: the money a goal represents is REAL money, not a private number.
--
-- The bug this fixes: a `goal_contribution` debited a real wallet while
-- `financial_goals.current_amount` rose by the same figure. Net worth is
-- `SUM(assets.current_value) - debt` and never adds goals back, so a household
-- became 10tr poorer for pressing "contribute". Money left the balance sheet
-- and landed nowhere.
--
-- Two backing modes replace that:
--
--   earmark      — a named claim on the household's general wallets. Nothing
--                  moves; `current_amount` stays the stored figure. Net worth
--                  is untouched because no asset is debited.
--   asset_backed — progress is DERIVED from a share of one or more assets
--                  (gold + crypto + stocks + cash can all feed "500tr by end of
--                  2026"). Nothing is stored to drift.
--
-- No new money-event type. "Taking money back out" is an `expense` that debits
-- an asset and, for an earmark goal, carries `financial_goal_id` so the claim
-- shrinks in the same transaction. Spending is the real event; the goal reacts.

-- Mode lives on the goal. Every existing goal is an earmark: that is exactly
-- what a stored `current_amount` with no asset link has always meant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GoalBackingMode') THEN
    CREATE TYPE "GoalBackingMode" AS ENUM ('earmark', 'asset_backed');
  END IF;
END $$;

-- How much of an asset a goal claims. `fixed` is a declared amount that does
-- not move when the asset reprices; `percent` is a share that does. The
-- household picks per allocation — 100tr of stocks can send 50tr to the car
-- goal while the rest stays unassigned.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GoalAllocationKind') THEN
    CREATE TYPE "GoalAllocationKind" AS ENUM ('fixed', 'percent');
  END IF;
END $$;

ALTER TABLE "financial_goals"
  ADD COLUMN IF NOT EXISTS "backing_mode" "GoalBackingMode" NOT NULL DEFAULT 'earmark';

CREATE TABLE IF NOT EXISTS "goal_asset_allocations" (
  "id" UUID NOT NULL,
  "household_id" UUID NOT NULL,
  "financial_goal_id" UUID NOT NULL,
  "asset_id" UUID NOT NULL,
  "kind" "GoalAllocationKind" NOT NULL,
  -- Exactly one of these carries the claim; the CHECK below enforces which.
  "allocated_amount" DECIMAL(14,2),
  "percent" DECIMAL(5,2),
  "note" TEXT,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "goal_asset_allocations_pkey" PRIMARY KEY ("id")
);

-- Deleting the goal or the asset removes the claim: an allocation has no
-- meaning without both ends. Soft-deleted rows keep their FK targets.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goal_asset_allocations_household_id_fkey'
  ) THEN
    ALTER TABLE "goal_asset_allocations"
      ADD CONSTRAINT "goal_asset_allocations_household_id_fkey"
      FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goal_asset_allocations_financial_goal_id_fkey'
  ) THEN
    ALTER TABLE "goal_asset_allocations"
      ADD CONSTRAINT "goal_asset_allocations_financial_goal_id_fkey"
      FOREIGN KEY ("financial_goal_id") REFERENCES "financial_goals"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goal_asset_allocations_asset_id_fkey'
  ) THEN
    ALTER TABLE "goal_asset_allocations"
      ADD CONSTRAINT "goal_asset_allocations_asset_id_fkey"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goal_asset_allocations_created_by_fkey'
  ) THEN
    ALTER TABLE "goal_asset_allocations"
      ADD CONSTRAINT "goal_asset_allocations_created_by_fkey"
      FOREIGN KEY ("created_by") REFERENCES "profiles"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goal_asset_allocations_updated_by_fkey'
  ) THEN
    ALTER TABLE "goal_asset_allocations"
      ADD CONSTRAINT "goal_asset_allocations_updated_by_fkey"
      FOREIGN KEY ("updated_by") REFERENCES "profiles"("id");
  END IF;
END $$;

-- The kind determines which column is populated. Storing both would let the two
-- disagree about what the household claimed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goal_asset_allocations_kind_matches_value'
  ) THEN
    ALTER TABLE "goal_asset_allocations"
      ADD CONSTRAINT "goal_asset_allocations_kind_matches_value"
      CHECK (
        ("kind" = 'fixed'   AND "allocated_amount" IS NOT NULL AND "allocated_amount" >= 0 AND "percent" IS NULL)
        OR
        ("kind" = 'percent' AND "percent" IS NOT NULL AND "percent" > 0 AND "percent" <= 100 AND "allocated_amount" IS NULL)
      );
  END IF;
END $$;

-- One live claim per (goal, asset). A second row for the same pair would be two
-- answers to one question; the household edits the existing claim instead.
-- Partial so a soft-deleted claim never blocks re-adding the asset.
CREATE UNIQUE INDEX IF NOT EXISTS "goal_asset_allocations_goal_asset_live_key"
  ON "goal_asset_allocations" ("financial_goal_id", "asset_id")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "goal_asset_allocations_household_id_idx"
  ON "goal_asset_allocations" ("household_id");

-- Resolving a goal's progress reads every live allocation for that goal;
-- checking over-allocation reads every live allocation for that asset.
CREATE INDEX IF NOT EXISTS "goal_asset_allocations_financial_goal_id_idx"
  ON "goal_asset_allocations" ("financial_goal_id");

CREATE INDEX IF NOT EXISTS "goal_asset_allocations_asset_id_idx"
  ON "goal_asset_allocations" ("asset_id");

-- Give the money back.
--
-- Every past `goal_contribution` debited a wallet for money that never left the
-- household — the balance sheet has been understated by the total contributed
-- ever since. Credit each source wallet with the sum it was wrongly debited,
-- then clear `from_asset_id` so the events match the new rule (an earmark
-- contribution names no source wallet, and `applyWalletEffects` must find
-- nothing to reverse if one of these events is later edited or deleted).
--
-- Written as `SET = value + (SELECT SUM …)` over a subquery keyed on the
-- events still carrying `from_asset_id`. Because the same statement clears that
-- column, a second run finds no rows and adds nothing: idempotent by
-- construction, not by guard.
UPDATE "assets" a
SET "current_value" = a."current_value" + refund.amount,
    "value_updated_at" = now(),
    "updated_at" = now()
FROM (
  SELECT "from_asset_id" AS asset_id, SUM("amount") AS amount
  FROM "money_events"
  WHERE "event_type" = 'goal_contribution'
    AND "from_asset_id" IS NOT NULL
    AND "deleted_at" IS NULL
  GROUP BY "from_asset_id"
) AS refund
WHERE a."id" = refund.asset_id
  AND a."deleted_at" IS NULL;

-- Each of those debits also appended an `asset_valuations` point recording the
-- wallet balance AFTER the wrong deduction. Leaving them behind would keep the
-- asset's value-over-time chart telling the old story, and snapshot lines
-- reference these points by `valuation_id` for lineage. Soft-delete them the
-- same way `removeValuationsForEvent` does when an event is edited away.
--
-- Ordered BEFORE the `from_asset_id` clear so the join still has its key.
UPDATE "asset_valuations" v
SET "deleted_at" = now(),
    "updated_at" = now()
FROM "money_events" e
WHERE v."money_event_id" = e."id"
  AND v."asset_id" = e."from_asset_id"
  AND v."deleted_at" IS NULL
  AND e."event_type" = 'goal_contribution'
  AND e."from_asset_id" IS NOT NULL
  AND e."deleted_at" IS NULL;

UPDATE "money_events"
SET "from_asset_id" = NULL,
    "updated_at" = now()
WHERE "event_type" = 'goal_contribution'
  AND "from_asset_id" IS NOT NULL
  AND "deleted_at" IS NULL;

-- PR3: remove dead / stale-cache columns; promote encoded data to real columns.
--
-- * snapshots.status / source_mode      -> DROP (derived at read time)
-- * enums SnapshotStatus/SourceMode     -> DROP (no longer referenced)
-- * snapshots.created_by                -> nullable + FK ON DELETE SET NULL
-- * financial_goals.current_amount      -> DROP (derived: Σ goal_contribution)
-- * debt_interest_periods.term_months   -> ADD, backfilled from the "months:N"
--                                          hint previously smuggled into `note`
--
-- Guarded so the migration is idempotent.

-- ----------------------------------------------------------------------------
-- snapshots: drop derived status/source_mode, relax created_by.
-- ----------------------------------------------------------------------------
ALTER TABLE "snapshots" DROP COLUMN IF EXISTS "status";
ALTER TABLE "snapshots" DROP COLUMN IF EXISTS "source_mode";

DROP TYPE IF EXISTS "SnapshotStatus";
DROP TYPE IF EXISTS "SnapshotSourceMode";

ALTER TABLE "snapshots" ALTER COLUMN "created_by" DROP NOT NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshots_created_by_fkey') THEN
    ALTER TABLE "snapshots" DROP CONSTRAINT "snapshots_created_by_fkey";
  END IF;
  ALTER TABLE "snapshots"
    ADD CONSTRAINT "snapshots_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "profiles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
END $$;

-- ----------------------------------------------------------------------------
-- financial_goals: drop the derived current_amount (and the CHECK that ref'd it,
-- re-adding a target-only non-negativity check).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_goals_amounts_nonneg') THEN
    ALTER TABLE "financial_goals" DROP CONSTRAINT "financial_goals_amounts_nonneg";
  END IF;
END $$;
ALTER TABLE "financial_goals" DROP COLUMN IF EXISTS "current_amount";
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_goals_target_nonneg') THEN
    ALTER TABLE "financial_goals" ADD CONSTRAINT "financial_goals_target_nonneg" CHECK ("target_amount" >= 0);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- debt_interest_periods: real term_months column, backfilled from note.
-- ----------------------------------------------------------------------------
ALTER TABLE "debt_interest_periods" ADD COLUMN IF NOT EXISTS "term_months" INTEGER;

UPDATE "debt_interest_periods"
   SET "term_months" = CAST(substring("note" FROM '^months:([0-9]+)$') AS INTEGER)
 WHERE "term_months" IS NULL
   AND "note" ~ '^months:[0-9]+$';

-- The note field no longer encodes months; clear the ones we just migrated so
-- it can be used for real user notes going forward.
UPDATE "debt_interest_periods"
   SET "note" = NULL
 WHERE "note" ~ '^months:[0-9]+$';

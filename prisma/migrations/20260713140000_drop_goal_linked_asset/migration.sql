-- Drop financial_goals.linked_asset_id entirely.
--
-- A goal no longer names a source wallet — the source of the money is chosen
-- per contribution (each goal_contribution money event carries its own
-- `fromAssetId`), not once on the goal. So the column, its FK and its index are
-- removed. See memory/goals.md + memory/money-events.md.
--
-- (Reverses 20260713120000_goal_source_asset_required, which had made this
-- column NOT NULL with an ON DELETE RESTRICT FK.)

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'financial_goals_linked_asset_id_fkey'
  ) THEN
    ALTER TABLE "financial_goals" DROP CONSTRAINT "financial_goals_linked_asset_id_fkey";
  END IF;
END $$;

DROP INDEX IF EXISTS "financial_goals_linked_asset_id_idx";

ALTER TABLE "financial_goals" DROP COLUMN IF EXISTS "linked_asset_id";

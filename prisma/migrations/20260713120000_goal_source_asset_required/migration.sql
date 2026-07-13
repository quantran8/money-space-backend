-- Goal source asset is now MANDATORY.
--
-- A financial goal must name the wallet (cash / bank_account) its contributions
-- come from — `financial_goals.linked_asset_id` becomes NOT NULL. Contributions
-- (goal_contribution money events) debit this wallet, so a goal with no source
-- would let progress rise without any money leaving a pocket (the bug this
-- fixes). See memory/goals.md + memory/money-events.md.
--
-- Backfill: existing goals with no linked asset are pointed at their household's
-- first spendable wallet (a cash / bank_account asset). Guarded + idempotent.

-- ----------------------------------------------------------------------------
-- 1. Backfill NULL linked_asset_id from the household's first wallet asset.
-- ----------------------------------------------------------------------------
UPDATE "financial_goals" g
   SET "linked_asset_id" = w.id
  FROM (
    SELECT DISTINCT ON (a."household_id")
           a."id", a."household_id"
      FROM "assets" a
     WHERE a."type" IN ('cash', 'bank_account')
       AND a."deleted_at" IS NULL
     ORDER BY a."household_id", a."created_at" ASC
  ) w
 WHERE g."linked_asset_id" IS NULL
   AND g."household_id" = w."household_id";

-- ----------------------------------------------------------------------------
-- 2. Enforce NOT NULL. Any goal still lacking a wallet (household has zero
--    cash/bank assets) blocks the migration — that is intentional: seed a wallet
--    for such a household first. In practice every active household has one.
-- ----------------------------------------------------------------------------
ALTER TABLE "financial_goals" ALTER COLUMN "linked_asset_id" SET NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. The source is mandatory, so its asset must not be silently nulled when the
--    asset is deleted — swap ON DELETE SET NULL for RESTRICT so an in-use wallet
--    can't be removed out from under a goal.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'financial_goals_linked_asset_id_fkey'
  ) THEN
    ALTER TABLE "financial_goals" DROP CONSTRAINT "financial_goals_linked_asset_id_fkey";
  END IF;
  ALTER TABLE "financial_goals"
    ADD CONSTRAINT "financial_goals_linked_asset_id_fkey"
    FOREIGN KEY ("linked_asset_id") REFERENCES "assets"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;

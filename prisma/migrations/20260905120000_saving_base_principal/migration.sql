-- The amount actually deposited into a saving deposit, kept apart from the
-- running `principal_amount`.
--
-- Capitalizing monthly interest (`interest_destination = 'principal'`) rewrites
-- `principal_amount` in place to principal + interest, so after the first
-- payout the original deposit is gone. Two flows need it back:
--   * early withdrawal claws interest back against money the household
--     actually put in, not against a balance that already contains interest;
--   * settling a `wallet`-destination deposit pays back only the deposit, since
--     its interest was paid out month by month and has already left.
--
-- Backfilled from `principal_amount`: for every existing row no interest has
-- ever been capitalized (nothing has ever run the accrual), so the two are
-- equal today. Nullable so a row written by an older client still loads;
-- readers fall back to `principal_amount`.
-- See memory/asset-valuation.md.

ALTER TABLE "asset_calculation_terms"
  ADD COLUMN IF NOT EXISTS "base_principal_amount" NUMERIC(14, 2);

UPDATE "asset_calculation_terms"
SET "base_principal_amount" = "principal_amount"
WHERE "base_principal_amount" IS NULL;

-- Simplify a debt's classification to a single field with three buckets.
--
-- Before: a debt carried both `debt_type` (8-value DebtType) and `lender_type`
-- (6-value LenderType). We keep only `lender_type` and collapse it to three
-- buckets that drive the repayment rules (see memory/debts.md):
--   relative | bank_institution | other
--
-- Mapping of the old 6-value LenderType onto the new 3:
--   family, friend            -> relative
--   bank, credit_institution  -> bank_institution
--   company, other            -> other
-- (`company` was a business lender with no fixed-schedule guarantee, so it maps
--  to `other` rather than `bank_institution`.)

-- 1. New enum. Postgres can't drop values from an in-use enum, so build the
--    replacement type and swap the column onto it.
CREATE TYPE "LenderType_new" AS ENUM ('relative', 'bank_institution', 'other');

-- 2. Repoint the column, remapping every existing row's value in the USING clause.
ALTER TABLE "debts"
  ALTER COLUMN "lender_type" TYPE "LenderType_new"
  USING (
    CASE "lender_type"::text
      WHEN 'family' THEN 'relative'
      WHEN 'friend' THEN 'relative'
      WHEN 'bank' THEN 'bank_institution'
      WHEN 'credit_institution' THEN 'bank_institution'
      WHEN 'company' THEN 'other'
      ELSE 'other'
    END
  )::"LenderType_new";

-- 3. Retire the old enum and rename the new one into its place.
DROP TYPE "LenderType";
ALTER TYPE "LenderType_new" RENAME TO "LenderType";

-- 4. Drop the now-redundant debt_type column and its enum.
ALTER TABLE "debts" DROP COLUMN "debt_type";
DROP TYPE "DebtType";

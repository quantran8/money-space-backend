-- PR5 (part 1): fold debt_terms into debts, drop the table.
--
-- debt_terms was used strictly 1:1 with values derived from the parent debt.
-- The real inputs (payment_frequency, fixed/minimum payment amounts,
-- interest_type, interest_calculation) move onto `debts`; the derived columns
-- (repayment_type, principal_payment_type, has_interest, grace_period_months)
-- and the table are dropped. repayment_type / has_interest are now derived on read.

-- 1. Add the folded-in columns to debts.
ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "payment_frequency" TEXT;
ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "fixed_payment_amount" DECIMAL(14,2);
ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "minimum_payment_amount" DECIMAL(14,2);
ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "interest_type" "DebtInterestType" NOT NULL DEFAULT 'none';
ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "interest_calculation" "DebtInterestCalculation";

-- 2. Backfill from the latest live term row per debt.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'debt_terms') THEN
    UPDATE "debts" d
       SET "payment_frequency"     = t."payment_frequency",
           "fixed_payment_amount"  = t."fixed_payment_amount",
           "minimum_payment_amount"= t."minimum_payment_amount",
           "interest_type"         = COALESCE(t."interest_type", 'none'),
           "interest_calculation"  = t."interest_calculation"
      FROM (
        SELECT DISTINCT ON (debt_id) *
          FROM "debt_terms"
         WHERE "deleted_at" IS NULL
         ORDER BY debt_id, "created_at" DESC
      ) t
     WHERE d."id" = t."debt_id";
  END IF;
END $$;

-- 3. Drop the table and the now-unused enums.
DROP TABLE IF EXISTS "debt_terms";
DROP TYPE IF EXISTS "DebtRepaymentType";
DROP TYPE IF EXISTS "DebtPrincipalPaymentType";

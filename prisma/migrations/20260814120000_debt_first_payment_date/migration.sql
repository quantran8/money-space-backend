-- Anchor recurring debt schedules to an explicit first due date instead of
-- deriving it implicitly from borrowed_at. Existing rows keep their current
-- behaviour through a one-time backfill.
ALTER TABLE "debts"
ADD COLUMN IF NOT EXISTS "first_payment_date" DATE;

UPDATE "debts"
SET "first_payment_date" = CASE "payment_frequency"
  WHEN 'monthly' THEN ("borrowed_at" + INTERVAL '1 month')::date
  WHEN 'quarterly' THEN ("borrowed_at" + INTERVAL '3 months')::date
  WHEN 'yearly' THEN ("borrowed_at" + INTERVAL '1 year')::date
  ELSE NULL
END
WHERE "first_payment_date" IS NULL
  AND "borrowed_at" IS NOT NULL
  AND "payment_frequency" IN ('monthly', 'quarterly', 'yearly');

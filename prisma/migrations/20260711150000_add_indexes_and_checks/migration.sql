-- PR1: partial indexes, partial-unique guards, and CHECK constraints.
--
-- Plain secondary / FK / sort indexes are declared as `@@index` / `@@unique`
-- in schema.prisma and emitted by Prisma. This migration adds ONLY what the
-- Prisma schema cannot express:
--   1. PARTIAL indexes `WHERE deleted_at IS NULL` for the largest soft-deleted
--      tables — the canonical list filter is `household_id = ? AND deleted_at
--      IS NULL`, and a partial index over live rows is smaller/faster than a
--      plain composite (Prisma has no partial-index syntax).
--   2. PARTIAL-UNIQUE guards (uniqueness only over live / non-null rows).
--   3. CHECK constraints (money/quantity/rate sanity).
--
-- All statements are guarded (IF NOT EXISTS / catalog lookup) so the migration
-- is idempotent.

-- ----------------------------------------------------------------------------
-- 1. Partial "live rows" indexes for the hottest soft-deleted tables.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "assets_household_live_idx"
  ON "assets" ("household_id") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "money_events_household_live_idx"
  ON "money_events" ("household_id", "event_date" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "asset_valuations_household_live_idx"
  ON "asset_valuations" ("household_id") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "upcoming_payments_household_live_idx"
  ON "upcoming_payments" ("household_id", "due_date") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "debts_household_live_idx"
  ON "debts" ("household_id") WHERE "deleted_at" IS NULL;

-- ----------------------------------------------------------------------------
-- 2. Partial-unique guards.
-- ----------------------------------------------------------------------------
-- One live valuation per asset per day (app upserts on this pair; a race could
-- otherwise create two rows for the same day).
CREATE UNIQUE INDEX IF NOT EXISTS "asset_valuations_asset_date_unique"
  ON "asset_valuations" ("asset_id", "valuation_date") WHERE "deleted_at" IS NULL;

-- One profile per email (email is nullable; multiple NULLs stay allowed).
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_email_unique"
  ON "profiles" ("email") WHERE "email" IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. CHECK constraints (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_current_value_nonneg') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_current_value_nonneg" CHECK ("current_value" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_market_positions_quantity_nonneg') THEN
    ALTER TABLE "asset_market_positions" ADD CONSTRAINT "asset_market_positions_quantity_nonneg" CHECK ("quantity" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'market_prices_price_nonneg') THEN
    ALTER TABLE "market_prices" ADD CONSTRAINT "market_prices_price_nonneg" CHECK ("price" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fx_rates_rate_positive') THEN
    ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_rate_positive" CHECK ("rate" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_valuations_value_nonneg') THEN
    ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_value_nonneg" CHECK ("value" >= 0);
  END IF;
  -- Non-negativity only. NOT `outstanding <= original`: revolving debts
  -- (credit_card) can legitimately exceed the initial principal.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'debts_amounts_nonneg') THEN
    ALTER TABLE "debts" ADD CONSTRAINT "debts_amounts_nonneg"
      CHECK ("original_amount" >= 0 AND "outstanding_amount" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_goals_amounts_nonneg') THEN
    ALTER TABLE "financial_goals" ADD CONSTRAINT "financial_goals_amounts_nonneg"
      CHECK ("target_amount" >= 0 AND "current_amount" >= 0);
  END IF;
END $$;

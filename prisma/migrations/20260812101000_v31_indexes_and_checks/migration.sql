-- v3.1 §32: the indexes and CHECK constraints the alignment requires.
--
-- Plain indexes here are ALSO declared as `@@index` in schema.prisma. That
-- duplication is deliberate: a previous `prisma db push`-style re-init rebuilt
-- the DB from schema.prisma alone and silently dropped every hand-written
-- partial index and CHECK — including the only household_id-leading index on
-- `assets`, which turned the hottest read path into a full table scan. Anything
-- schema.prisma CAN express must therefore live there too.
--
-- Every statement is guarded so the migration is idempotent.

-- ----------------------------------------------------------------------------
-- 1. Plain indexes (§32). Mirrored in schema.prisma.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "assets_household_id_deleted_at_idx"
  ON "assets" ("household_id", "deleted_at");
CREATE INDEX IF NOT EXISTS "assets_household_id_type_idx"
  ON "assets" ("household_id", "type");
CREATE INDEX IF NOT EXISTS "assets_household_id_liquidity_idx"
  ON "assets" ("household_id", "liquidity");
CREATE INDEX IF NOT EXISTS "assets_household_id_financial_nature_idx"
  ON "assets" ("household_id", "financial_nature");
CREATE INDEX IF NOT EXISTS "assets_privacy_owner_member_id_idx"
  ON "assets" ("privacy_owner_member_id");

CREATE INDEX IF NOT EXISTS "money_events_household_id_event_type_idx"
  ON "money_events" ("household_id", "event_type");
CREATE INDEX IF NOT EXISTS "money_events_household_id_category_idx"
  ON "money_events" ("household_id", "category");
CREATE INDEX IF NOT EXISTS "money_events_privacy_owner_member_id_idx"
  ON "money_events" ("privacy_owner_member_id");

CREATE INDEX IF NOT EXISTS "financial_goals_household_id_target_date_idx"
  ON "financial_goals" ("household_id", "target_date");

CREATE INDEX IF NOT EXISTS "debt_interest_periods_household_id_debt_id_idx"
  ON "debt_interest_periods" ("household_id", "debt_id");

-- ----------------------------------------------------------------------------
-- 2. Partial "live rows" index restored for debts (mirrored by the plain
--    [household_id, deleted_at] index in schema.prisma).
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "debts_household_id_deleted_at_idx"
  ON "debts" ("household_id", "deleted_at");

-- ----------------------------------------------------------------------------
-- 3. CHECK constraints. Postgres has no ADD CONSTRAINT IF NOT EXISTS.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  -- households
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'households_name_not_blank') THEN
    ALTER TABLE "households" ADD CONSTRAINT "households_name_not_blank"
      CHECK (btrim("name") <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'households_currency_not_blank') THEN
    ALTER TABLE "households" ADD CONSTRAINT "households_currency_not_blank"
      CHECK (btrim("currency") <> '');
  END IF;

  -- household_invites: an invite must be reachable somehow.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'household_invites_contact_present') THEN
    ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_contact_present"
      CHECK ("invitee_email" IS NOT NULL OR "invitee_phone" IS NOT NULL) NOT VALID;
  END IF;

  -- snapshots: totals are non-negative. NOTE the deliberate absence of any
  -- CHECK on lowest_projected_balance / flexible_money (§10 — both may be
  -- negative, and that is the signal).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshots_totals_nonneg') THEN
    ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_totals_nonneg" CHECK (
      "total_liquid" >= 0
      AND "total_savings" >= 0
      AND "total_long_term_assets" >= 0
      AND "total_debt" >= 0
      AND "attention_count" >= 0
    ) NOT VALID;
  END IF;

  -- assets
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_name_not_blank') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_name_not_blank"
      CHECK (btrim("name") <> '') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_currency_not_blank') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_currency_not_blank"
      CHECK (btrim("currency") <> '') NOT VALID;
  END IF;

  -- asset_valuations
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_valuations_currency_not_blank') THEN
    ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_currency_not_blank"
      CHECK (btrim("currency") <> '') NOT VALID;
  END IF;

  -- money_events
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_events_amount_nonneg') THEN
    ALTER TABLE "money_events" ADD CONSTRAINT "money_events_amount_nonneg"
      CHECK ("amount" >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_events_currency_not_blank') THEN
    ALTER TABLE "money_events" ADD CONSTRAINT "money_events_currency_not_blank"
      CHECK (btrim("currency") <> '') NOT VALID;
  END IF;

  -- financial_goals
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_goals_current_nonneg') THEN
    ALTER TABLE "financial_goals" ADD CONSTRAINT "financial_goals_current_nonneg"
      CHECK ("current_amount" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_goals_pmc_nonneg') THEN
    ALTER TABLE "financial_goals" ADD CONSTRAINT "financial_goals_pmc_nonneg"
      CHECK ("planned_monthly_contribution" IS NULL OR "planned_monthly_contribution" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_goals_name_not_blank') THEN
    ALTER TABLE "financial_goals" ADD CONSTRAINT "financial_goals_name_not_blank"
      CHECK (btrim("name") <> '') NOT VALID;
  END IF;

  -- money_event_categories
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_event_categories_code_not_blank') THEN
    ALTER TABLE "money_event_categories" ADD CONSTRAINT "money_event_categories_code_not_blank"
      CHECK (btrim("code") <> '') NOT VALID;
  END IF;

  -- currencies
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'currencies_code_not_blank') THEN
    ALTER TABLE "currencies" ADD CONSTRAINT "currencies_code_not_blank"
      CHECK (btrim("code") <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'currencies_decimals_nonneg') THEN
    ALTER TABLE "currencies" ADD CONSTRAINT "currencies_decimals_nonneg"
      CHECK ("decimals" >= 0);
  END IF;

  -- asset_calculation_terms
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_calculation_terms_rates_nonneg') THEN
    ALTER TABLE "asset_calculation_terms" ADD CONSTRAINT "asset_calculation_terms_rates_nonneg" CHECK (
      "principal_amount" >= 0
      AND COALESCE("interest_rate", 0) >= 0
      AND COALESCE("coupon_rate", 0) >= 0
      AND COALESCE("expected_return_rate", 0) >= 0
    ) NOT VALID;
  END IF;

  -- fx_rates / asset_market_positions
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fx_rates_currencies_not_blank') THEN
    ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_currencies_not_blank"
      CHECK (btrim("base_currency") <> '' AND btrim("quote_currency") <> '') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_market_positions_quote_currency_not_blank') THEN
    ALTER TABLE "asset_market_positions"
      ADD CONSTRAINT "asset_market_positions_quote_currency_not_blank"
      CHECK (btrim("quote_currency") <> '') NOT VALID;
  END IF;
END $$;

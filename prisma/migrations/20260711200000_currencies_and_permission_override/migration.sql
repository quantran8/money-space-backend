-- PR6: currencies reference table + FKs; permission_level becomes a nullable
-- override.

-- ----------------------------------------------------------------------------
-- 1. Currencies reference table (ISO-4217), seeded.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "currencies" (
  "code"      CHAR(3) PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "symbol"    TEXT,
  "decimals"  INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO "currencies" ("code", "name", "symbol", "decimals") VALUES
  ('VND', 'Vietnamese Dong', '₫', 0),
  ('USD', 'US Dollar', '$', 2),
  ('EUR', 'Euro', '€', 2),
  ('THB', 'Thai Baht', '฿', 2),
  ('JPY', 'Japanese Yen', '¥', 0),
  ('GBP', 'Pound Sterling', '£', 2),
  ('AUD', 'Australian Dollar', 'A$', 2),
  ('SGD', 'Singapore Dollar', 'S$', 2),
  ('CNY', 'Chinese Yuan', '¥', 2),
  ('KRW', 'South Korean Won', '₩', 0)
ON CONFLICT ("code") DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. FKs from every currency column. Added NOT VALID so pre-existing rows with
--    non-catalog codes don't block the migration; new/updated rows are checked.
--    (VALIDATE CONSTRAINT later once data is confirmed clean.)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN SELECT * FROM (VALUES
    ('households',            'currency',       'households_currency_fkey'),
    ('assets',               'currency',       'assets_currency_fkey'),
    ('asset_market_positions','quote_currency', 'amp_quote_currency_fkey'),
    ('market_prices',        'quote_currency', 'market_prices_quote_currency_fkey'),
    ('fx_rates',             'base_currency',  'fx_rates_base_currency_fkey'),
    ('fx_rates',             'quote_currency', 'fx_rates_quote_currency_fkey'),
    ('asset_calculation_terms','currency',     'act_currency_fkey'),
    ('asset_valuations',     'currency',       'asset_valuations_currency_fkey'),
    ('snapshot_asset_values','currency',       'sav_currency_fkey'),
    ('debts',                'currency',       'debts_currency_fkey'),
    ('money_events',         'currency',       'money_events_currency_fkey')
  ) AS t(tbl, col, conname)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.conname) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES currencies(code) NOT VALID',
        fk.tbl, fk.conname, fk.col
      );
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 3. permission_level → nullable override (NULL = derive from role).
-- ----------------------------------------------------------------------------
ALTER TABLE "household_members" ALTER COLUMN "permission_level" DROP NOT NULL;
ALTER TABLE "household_members" ALTER COLUMN "permission_level" DROP DEFAULT;
ALTER TABLE "household_invites" ALTER COLUMN "default_permission_level" DROP NOT NULL;
ALTER TABLE "household_invites" ALTER COLUMN "default_permission_level" DROP DEFAULT;

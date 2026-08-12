-- Restore the `currencies(code)` foreign keys (v3.1 §14A).
--
-- 20260711200000 added FKs from all 11 currency columns. The squash
-- `20260712074514_init` then rebuilt the schema from schema.prisma — which
-- cannot express them, because `Currency` is deliberately not a Prisma relation
-- (it would add ~11 back-relations for a static lookup table) — and dropped
-- every one of them. This restores them against the CURRENT table list:
--
--   * `asset_valuations`  — renamed back from asset_value_history (this release)
--   * `market_prices`     — OMITTED: the table was dropped in 20260714230000.
--                           Prices now cache on asset_market_positions.last_price.
--
-- Added NOT VALID so a pre-existing row holding a code outside the seeded
-- catalog cannot block the deploy; new and updated rows are checked immediately.
-- Run VALIDATE CONSTRAINT in a follow-up once the data is confirmed clean.

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN SELECT * FROM (VALUES
    ('households',             'currency',       'households_currency_fkey'),
    ('assets',                 'currency',       'assets_currency_fkey'),
    ('asset_market_positions', 'quote_currency', 'amp_quote_currency_fkey'),
    ('fx_rates',               'base_currency',  'fx_rates_base_currency_fkey'),
    ('fx_rates',               'quote_currency', 'fx_rates_quote_currency_fkey'),
    ('asset_calculation_terms','currency',       'act_currency_fkey'),
    ('asset_valuations',       'currency',       'asset_valuations_currency_fkey'),
    ('snapshot_asset_values',  'currency',       'sav_currency_fkey'),
    ('debts',                  'currency',       'debts_currency_fkey'),
    ('money_events',           'currency',       'money_events_currency_fkey')
  ) AS t(tbl, col, conname)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.conname)
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = fk.tbl
            AND column_name = fk.col
       )
    THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES currencies(code) NOT VALID',
        fk.tbl, fk.conname, fk.col
      );
    END IF;
  END LOOP;
END $$;

-- Apply the `currencies(code)` foreign keys (v3.1 §14A).
--
-- 20260812102000_restore_currency_fks holds the same DO block, but was recorded
-- with applied_steps_count = 0 — baselined, never executed — so this database
-- has ZERO foreign keys onto `currencies` and every currency column is free
-- text. A typo ("usd", "US$", "") is accepted today and only surfaces later as
-- an asset that values at 0 (fxRateToVnd finds no rate for it).
--
-- Idempotent and safe to re-run: each constraint is added only if absent, and
-- only for a column that exists. Re-stating it rather than editing the old
-- migration, whose checksum is already recorded.
--
-- NOT VALID so a pre-existing out-of-catalog row cannot block the deploy; new
-- and updated rows are checked immediately. The VALIDATE pass below is separate
-- and takes only a SHARE UPDATE EXCLUSIVE lock.

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

-- Validate now: the data is clean (every row is 'VND'), so this costs nothing
-- and turns the constraints into real guarantees rather than forward-only ones.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT conname, conrelid::regclass AS tbl
      FROM pg_constraint
     WHERE contype = 'f'
       AND confrelid = 'currencies'::regclass
       AND NOT convalidated
  LOOP
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', fk.tbl, fk.conname);
  END LOOP;
END $$;

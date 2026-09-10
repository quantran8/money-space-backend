-- Move crypto positions from đồng to USD (the currency crypto is quoted in).
--
-- New positions store `quote_currency = 'USD'` with `purchase_price` in USD.
-- Rows created before that hold đồng, which still VALUES correctly but states a
-- cost basis in đồng — see memory/market-data.md.
--
-- Converted at the latest USD/VND reference rate; the purchase-day rate is not
-- recorded. Value-preserving: the same đồng cost basis comes back out.
--
-- **Seeds a bootstrap rate when `fx_rates` is empty.** On a fresh deploy the FX
-- capture has not run yet, and a migration that skipped would still be recorded
-- as applied — leaving those rows in đồng forever with nothing to retry them.
-- The seeded rate is replaced by the real one on the next capture; it exists so
-- this conversion is never silently skipped.
-- Re-runnable: only `quote_currency = 'VND'` crypto rows are touched.

DO $$
DECLARE
  -- Only used when the table is empty. Approximate by construction, and
  -- superseded by the first real capture.
  bootstrap_rate CONSTANT NUMERIC := 25790;
  usd_rate       NUMERIC;
  moved          INTEGER;
BEGIN
  -- Nothing to convert → do not seed a rate this database has not asked for.
  IF NOT EXISTS (
    SELECT 1 FROM asset_market_positions
     WHERE asset_class = 'crypto'
       AND quote_currency = 'VND'
       AND deleted_at IS NULL
  ) THEN
    RAISE NOTICE 'No đồng-quoted crypto positions — nothing to convert';
    RETURN;
  END IF;

  SELECT rate INTO usd_rate
    FROM fx_rates
   WHERE base_currency = 'USD' AND quote_currency = 'VND'
   ORDER BY rate_time DESC
   LIMIT 1;

  IF usd_rate IS NULL OR usd_rate <= 0 THEN
    -- `currencies` is seeded with USD and VND, so the FK holds.
    INSERT INTO fx_rates (id, base_currency, quote_currency, rate, rate_time, source)
    VALUES (gen_random_uuid(), 'USD', 'VND', bootstrap_rate, now(), 'migration-bootstrap')
    ON CONFLICT DO NOTHING;
    usd_rate := bootstrap_rate;
    RAISE NOTICE 'fx_rates had no USD row — seeded bootstrap rate %', bootstrap_rate;
  END IF;

  UPDATE asset_market_positions
     SET purchase_price = ROUND(purchase_price / usd_rate, 8),
         last_price     = CASE
                            WHEN last_price IS NULL THEN NULL
                            ELSE ROUND(last_price / usd_rate, 8)
                          END,
         quote_currency = 'USD'
   WHERE asset_class = 'crypto'
     AND quote_currency = 'VND'
     AND deleted_at IS NULL;

  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'Converted % crypto position(s) to USD at %', moved, usd_rate;
END $$;

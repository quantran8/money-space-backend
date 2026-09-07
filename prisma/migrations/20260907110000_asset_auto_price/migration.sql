-- Whether an asset's price is refreshed automatically by the valuation cron.
--
-- Separate from `valuation_mode` on purpose: creating a market-priced asset is
-- never blocked by the plan, only the AUTOMATION is limited. An asset over a
-- free household's ceiling is still created and still `market_priced`; it
-- simply lands with this false.
--
-- DEFAULT true so every existing asset keeps refreshing exactly as it did —
-- this migration changes no behaviour on its own.
ALTER TABLE "assets"
  ADD COLUMN "auto_price_enabled" BOOLEAN NOT NULL DEFAULT true;

-- The valuation cron scans for market-priced assets due a refresh and now
-- filters on this column too. Partial, because the only rows it ever looks at
-- are the live, market-priced, automatic ones — which on a free-heavy user base
-- is a small fraction of the table.
CREATE INDEX IF NOT EXISTS "assets_auto_price_idx"
  ON "assets" ("household_id")
  WHERE "deleted_at" IS NULL
    AND "status" = 'active'
    AND "valuation_mode" = 'market_priced'
    AND "auto_price_enabled" = true;

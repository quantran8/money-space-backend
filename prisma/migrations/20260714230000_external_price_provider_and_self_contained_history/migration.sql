ALTER TABLE "asset_value_history"
  DROP CONSTRAINT IF EXISTS "asset_value_history_market_price_id_fkey";

ALTER TABLE "asset_value_history"
  DROP COLUMN IF EXISTS "market_price_id",
  ADD COLUMN "quantity" DECIMAL(20, 8),
  ADD COLUMN "observed_unit_price" DECIMAL(20, 8),
  ADD COLUMN "purchase_price" DECIMAL(20, 8),
  ADD COLUMN "quote_currency" TEXT,
  ADD COLUMN "fx_rate_used" DECIMAL(20, 8),
  ADD COLUMN "price_source" TEXT,
  ADD COLUMN "price_observed_at" TIMESTAMPTZ;

DROP TABLE IF EXISTS "market_prices";

ALTER TABLE "asset_value_history"
  DROP COLUMN IF EXISTS "quantity",
  DROP COLUMN IF EXISTS "observed_unit_price",
  DROP COLUMN IF EXISTS "purchase_price",
  DROP COLUMN IF EXISTS "quote_currency",
  DROP COLUMN IF EXISTS "fx_rate_used",
  DROP COLUMN IF EXISTS "price_source",
  DROP COLUMN IF EXISTS "price_observed_at";

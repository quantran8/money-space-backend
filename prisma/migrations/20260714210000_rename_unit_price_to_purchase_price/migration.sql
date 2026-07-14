ALTER TABLE "asset_market_positions"
RENAME COLUMN "unit_price" TO "purchase_price";

COMMENT ON COLUMN "asset_market_positions"."purchase_price" IS
  'Original purchase price per unit (cost basis); current price lives in last_price';

-- Add a user-entered unit price to market positions.
-- When set, asset valuation uses quantity × unit_price × fx instead of the
-- cached market price. NULL means "fall back to the market-price cache".
ALTER TABLE "asset_market_positions" ADD COLUMN "unit_price" DECIMAL(20,8);

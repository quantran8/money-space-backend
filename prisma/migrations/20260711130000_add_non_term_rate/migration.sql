-- Add a non-term interest rate to calculation terms.
-- Applied when a saving deposit is withdrawn before maturity (lãi suất không
-- kỳ hạn) — the contracted rate is void and this low rate applies instead.
-- NULL means "not set" (treated as 0 by the app).
ALTER TABLE "asset_calculation_terms" ADD COLUMN "non_term_rate" DECIMAL(8,4);

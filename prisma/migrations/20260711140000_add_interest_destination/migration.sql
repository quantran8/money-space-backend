-- Where auto-credited monthly saving-deposit interest lands.
-- `interest_destination`: 'wallet' credits `receiving_wallet_id` each month;
-- 'principal' capitalizes the interest into the deposit. NULL = 'principal'.
ALTER TABLE "asset_calculation_terms" ADD COLUMN "interest_destination" TEXT;
ALTER TABLE "asset_calculation_terms" ADD COLUMN "receiving_wallet_id" UUID;

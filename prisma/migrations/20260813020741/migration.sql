-- DropForeignKey
ALTER TABLE "asset_calculation_terms" DROP CONSTRAINT "act_currency_fkey";

-- DropForeignKey
ALTER TABLE "asset_market_positions" DROP CONSTRAINT "amp_quote_currency_fkey";

-- DropForeignKey
ALTER TABLE "asset_valuations" DROP CONSTRAINT "asset_valuations_currency_fkey";

-- DropForeignKey
ALTER TABLE "assets" DROP CONSTRAINT "assets_currency_fkey";

-- DropForeignKey
ALTER TABLE "debts" DROP CONSTRAINT "debts_currency_fkey";

-- DropForeignKey
ALTER TABLE "fx_rates" DROP CONSTRAINT "fx_rates_base_currency_fkey";

-- DropForeignKey
ALTER TABLE "fx_rates" DROP CONSTRAINT "fx_rates_quote_currency_fkey";

-- DropForeignKey
ALTER TABLE "households" DROP CONSTRAINT "households_currency_fkey";

-- DropForeignKey
ALTER TABLE "money_events" DROP CONSTRAINT "money_events_currency_fkey";

-- DropForeignKey
ALTER TABLE "snapshot_asset_values" DROP CONSTRAINT "sav_currency_fkey";

-- AlterTable
ALTER TABLE "protected_reserves" ALTER COLUMN "updated_at" DROP DEFAULT;

/*
  Warnings:

  - A unique constraint covering the columns `[base_currency,quote_currency,source,rate_time]` on the table `fx_rates` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[asset_class,symbol,market,quote_currency,source,price_time]` on the table `market_prices` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[household_id,code]` on the table `money_event_categories` will be added. If there are existing duplicate values, this will fail.

*/
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
ALTER TABLE "market_prices" DROP CONSTRAINT "market_prices_quote_currency_fkey";

-- DropForeignKey
ALTER TABLE "money_event_categories" DROP CONSTRAINT "money_event_categories_household_id_fkey";

-- DropForeignKey
ALTER TABLE "money_events" DROP CONSTRAINT "money_events_currency_fkey";

-- DropForeignKey
ALTER TABLE "snapshot_asset_values" DROP CONSTRAINT "sav_currency_fkey";

-- CreateIndex
CREATE INDEX "asset_calculation_terms_household_id_asset_id_idx" ON "asset_calculation_terms"("household_id", "asset_id");

-- CreateIndex
CREATE INDEX "asset_calculation_terms_calculation_type_status_idx" ON "asset_calculation_terms"("calculation_type", "status");

-- CreateIndex
CREATE INDEX "asset_market_positions_household_id_asset_id_idx" ON "asset_market_positions"("household_id", "asset_id");

-- CreateIndex
CREATE INDEX "asset_market_positions_asset_class_symbol_market_idx" ON "asset_market_positions"("asset_class", "symbol", "market");

-- CreateIndex
CREATE INDEX "asset_valuations_asset_id_valuation_date_idx" ON "asset_valuations"("asset_id", "valuation_date" DESC);

-- CreateIndex
CREATE INDEX "asset_valuations_household_id_asset_id_valuation_date_idx" ON "asset_valuations"("household_id", "asset_id", "valuation_date" DESC);

-- CreateIndex
CREATE INDEX "assets_holder_member_id_idx" ON "assets"("holder_member_id");

-- CreateIndex
CREATE INDEX "attention_items_household_id_status_idx" ON "attention_items"("household_id", "status");

-- CreateIndex
CREATE INDEX "attention_items_household_id_level_idx" ON "attention_items"("household_id", "level");

-- CreateIndex
CREATE INDEX "attention_items_related_object_type_related_object_id_idx" ON "attention_items"("related_object_type", "related_object_id");

-- CreateIndex
CREATE INDEX "audit_logs_household_id_created_at_idx" ON "audit_logs"("household_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "debt_interest_periods_debt_id_idx" ON "debt_interest_periods"("debt_id");

-- CreateIndex
CREATE INDEX "debts_household_id_status_idx" ON "debts"("household_id", "status");

-- CreateIndex
CREATE INDEX "debts_received_to_asset_id_idx" ON "debts"("received_to_asset_id");

-- CreateIndex
CREATE INDEX "debts_owner_member_id_idx" ON "debts"("owner_member_id");

-- CreateIndex
CREATE INDEX "financial_goals_household_id_status_idx" ON "financial_goals"("household_id", "status");

-- CreateIndex
CREATE INDEX "financial_goals_linked_asset_id_idx" ON "financial_goals"("linked_asset_id");

-- CreateIndex
CREATE INDEX "fx_rates_base_currency_quote_currency_rate_time_idx" ON "fx_rates"("base_currency", "quote_currency", "rate_time" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "fx_rates_dedup_unique" ON "fx_rates"("base_currency", "quote_currency", "source", "rate_time");

-- CreateIndex
CREATE INDEX "household_invites_household_id_status_idx" ON "household_invites"("household_id", "status");

-- CreateIndex
CREATE INDEX "household_members_user_id_idx" ON "household_members"("user_id");

-- CreateIndex
CREATE INDEX "households_created_by_idx" ON "households"("created_by");

-- CreateIndex
CREATE INDEX "households_deleted_at_idx" ON "households"("deleted_at");

-- CreateIndex
CREATE INDEX "market_prices_asset_class_symbol_market_quote_currency_pric_idx" ON "market_prices"("asset_class", "symbol", "market", "quote_currency", "price_time" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "market_prices_dedup_unique" ON "market_prices"("asset_class", "symbol", "market", "quote_currency", "source", "price_time");

-- CreateIndex
CREATE UNIQUE INDEX "money_event_categories_scope_code" ON "money_event_categories"("household_id", "code");

-- CreateIndex
CREATE INDEX "money_events_household_id_event_date_idx" ON "money_events"("household_id", "event_date" DESC);

-- CreateIndex
CREATE INDEX "money_events_from_asset_id_idx" ON "money_events"("from_asset_id");

-- CreateIndex
CREATE INDEX "money_events_to_asset_id_idx" ON "money_events"("to_asset_id");

-- CreateIndex
CREATE INDEX "money_events_debt_id_idx" ON "money_events"("debt_id");

-- CreateIndex
CREATE INDEX "money_events_financial_goal_id_idx" ON "money_events"("financial_goal_id");

-- CreateIndex
CREATE INDEX "money_events_upcoming_payment_id_idx" ON "money_events"("upcoming_payment_id");

-- CreateIndex
CREATE INDEX "money_events_snapshot_id_idx" ON "money_events"("snapshot_id");

-- CreateIndex
CREATE INDEX "snapshot_asset_values_household_id_snapshot_id_idx" ON "snapshot_asset_values"("household_id", "snapshot_id");

-- CreateIndex
CREATE INDEX "snapshot_asset_values_asset_id_idx" ON "snapshot_asset_values"("asset_id");

-- CreateIndex
CREATE INDEX "snapshots_household_id_snapshot_date_idx" ON "snapshots"("household_id", "snapshot_date" DESC);

-- CreateIndex
CREATE INDEX "upcoming_payments_household_id_due_date_idx" ON "upcoming_payments"("household_id", "due_date");

-- CreateIndex
CREATE INDEX "upcoming_payments_household_id_status_idx" ON "upcoming_payments"("household_id", "status");

-- CreateIndex
CREATE INDEX "upcoming_payments_debt_id_idx" ON "upcoming_payments"("debt_id");

-- AddForeignKey
ALTER TABLE "money_event_categories" ADD CONSTRAINT "money_event_categories_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "household_members_household_live_idx" RENAME TO "household_members_household_id_deleted_at_idx";

-- RenameIndex
ALTER INDEX "money_event_categories_household_live_idx" RENAME TO "money_event_categories_household_id_deleted_at_idx";

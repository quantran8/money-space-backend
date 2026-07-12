-- Rename `asset_valuations` -> `asset_value_history` to reflect its true role: a
-- time series of an asset's value (one row per value-changing action), not a
-- single current valuation. Also link each point to the money event that
-- produced it, so an event edit/delete can update/soft-delete exactly its
-- point(s). RENAME preserves all existing rows.

-- Rename the table (data preserved).
ALTER TABLE "asset_valuations" RENAME TO "asset_value_history";

-- Keep index names aligned with the new table name.
ALTER INDEX "asset_valuations_asset_id_valuation_date_idx"
  RENAME TO "asset_value_history_asset_id_valuation_date_idx";
ALTER INDEX "asset_valuations_household_id_asset_id_valuation_date_idx"
  RENAME TO "asset_value_history_household_id_asset_id_valuation_date_idx";

-- Link each value point to the money event whose effect produced it.
ALTER TABLE "asset_value_history" ADD COLUMN "money_event_id" UUID;

-- CreateIndex
CREATE INDEX "asset_value_history_money_event_id_idx"
  ON "asset_value_history"("money_event_id");

-- AddForeignKey
ALTER TABLE "asset_value_history"
  ADD CONSTRAINT "asset_value_history_money_event_id_fkey"
  FOREIGN KEY ("money_event_id") REFERENCES "money_events"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

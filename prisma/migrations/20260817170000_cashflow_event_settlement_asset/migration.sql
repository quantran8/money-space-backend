-- Cashflow events: which wallet the money actually moves through.
--
-- Completing an event writes a money event whose from/to asset drives
-- `applyWalletEffects`. With no asset on either side that function debits and
-- credits nothing, so the household could confirm "lương 20tr" and watch every
-- balance stay exactly where it was — the completion looked settled and moved
-- no money.
--
-- The column is NULLABLE on purpose: at planning time the household often does
-- not know yet which account a bill will come out of. Completion falls back to
-- this value and requires one to be chosen when it is null (service-level, so
-- the message can explain why).
--
-- Distinct from `planned_asset_id`, which is what the money BUYS, not where it
-- comes from.
ALTER TABLE "cashflow_events"
  ADD COLUMN IF NOT EXISTS "settlement_asset_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cashflow_events_settlement_asset_id_fkey'
  ) THEN
    ALTER TABLE "cashflow_events"
      ADD CONSTRAINT "cashflow_events_settlement_asset_id_fkey"
      FOREIGN KEY ("settlement_asset_id") REFERENCES "assets"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill: a completed event already recorded the wallet it settled through,
-- so reuse it rather than leaving the series to ask again next month.
UPDATE "cashflow_events"
   SET "settlement_asset_id" = "last_completed_asset_id"
 WHERE "settlement_asset_id" IS NULL
   AND "last_completed_asset_id" IS NOT NULL;

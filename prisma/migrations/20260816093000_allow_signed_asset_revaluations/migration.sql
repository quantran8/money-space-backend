-- Direct asset revaluations store their signed delta in money_events.amount.
-- A decrease therefore needs a negative amount, while every event that moves
-- money continues to use a non-negative magnitude plus its direction/links.
ALTER TABLE "money_events"
  DROP CONSTRAINT IF EXISTS "money_events_amount_nonneg";

ALTER TABLE "money_events"
  ADD CONSTRAINT "money_events_amount_nonneg"
  CHECK (
    "amount" >= 0
    OR "event_type" = 'asset_update'::"MoneyEventType"
  ) NOT VALID;

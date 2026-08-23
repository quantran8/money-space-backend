-- Backfill: completed cashflow events recorded as `payment_paid` with
-- `direction = 'neutral'`.
--
-- `deriveDirection` had no branch for `payment_paid`, so it fell through to the
-- `neutral` default. Money HAD left the household — `applyWalletEffects` keys
-- off from/to asset, not direction, so wallet balances were always right — but
-- everything that sums by direction skipped these rows: the month's chi
-- (`summarizeMonth` groups on inflow/outflow only) and each debt's repaid total
-- (`sumRepaidOutflows` filters `direction = 'outflow'`).
--
-- Only rows that actually moved money out are touched: `from_asset_id` is the
-- wallet that was debited. A `payment_paid` with no source wallet moved nothing,
-- so it stays neutral. Re-runnable — the second run matches nothing.
UPDATE "money_events"
SET "direction" = 'outflow'::"MoneyDirection"
WHERE "event_type" = 'payment_paid'::"MoneyEventType"
  AND "direction" = 'neutral'::"MoneyDirection"
  AND "from_asset_id" IS NOT NULL
  AND "deleted_at" IS NULL;

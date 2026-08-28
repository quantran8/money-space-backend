-- Quantity changes on a market-priced asset stop being revaluations.
--
-- Until now, editing an asset's `quantity` (buying more gold, correcting a
-- typo'd holding) routed through `logRevaluation` and was written as an
-- `asset_update` — the event type that means "the user re-priced this asset".
-- The value delta it carried was therefore read as a PRICE movement: dropping a
-- holding from 10 chỉ to 1 chỉ showed up as a ~720tr loss the household never
-- incurred, and the value-history curve dipped exactly like a market crash.
--
-- Accounting keeps these apart, and so do we from here on. A quantity change
-- that is not a purchase or a sale is an inventory adjustment: it offsets
-- against an adjustment account, never against cash, and never lands in P&L.
-- `asset_quantity_adjustment` is that offset. It is `neutral` (deriveDirection
-- falls through to it), so `summarizeMonth` — which groups on inflow/outflow —
-- leaves it out of thu/chi for free, exactly as it already does `asset_update`.
--
-- Safe as ADD VALUE: the new label is not USED anywhere in this migration, so
-- it does not hit Postgres' "unsafe use of new enum value in the same
-- transaction" rule. The code that writes it ships after this lands.
ALTER TYPE "MoneyEventType" ADD VALUE IF NOT EXISTS 'asset_quantity_adjustment';

-- The quantity held on each side of the change.
--
-- Without these, an asset's quantity over time is not reconstructible.
-- `buildMarketValueHistory` rebuilds it by adding back `sold_quantity` from
-- each sale, resting on the invariant its own comment states — "Only sales out
-- of this asset changed the quantity held". A quantity adjustment breaks that
-- invariant, and so does an `asset_purchase` that adds to an existing position
-- (already true today, already wrong). Recording both sides makes the series
-- self-describing: every event that moves quantity says what it moved from and
-- to, so history can be replayed without inferring anything.
--
-- Nullable because only quantity-bearing events carry them; an expense or a
-- transfer has no position to describe.
ALTER TABLE "money_events"
  ADD COLUMN IF NOT EXISTS "quantity_before" DECIMAL(20,8),
  ADD COLUMN IF NOT EXISTS "quantity_after"  DECIMAL(20,8);

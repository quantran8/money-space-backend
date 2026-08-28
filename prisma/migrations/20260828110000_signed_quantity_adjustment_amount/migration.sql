-- Let a quantity adjustment carry a negative amount.
--
-- `money_events_amount_nonneg` permits a negative `amount` only for
-- `asset_update`: a revaluation stores a SIGNED delta, while every event that
-- moves money stores a non-negative magnitude plus its direction and links.
--
-- `asset_quantity_adjustment` stores a signed delta for the same reason — a
-- holding corrected downward is worth less than the one on record — so
-- correcting 10 chỉ to 1 chỉ was rejected by the check. It belongs in the same
-- exception, not in a workaround that stores the magnitude and loses the sign:
-- the sign is what says whether the correction added or removed value.
--
-- Split out of `20260828100000_asset_quantity_adjustment` rather than folded
-- into it because that migration is already applied; amending it would only
-- break Prisma's checksum.
--
-- A CHECK cannot be amended in place, so it is dropped and recreated. `NOT
-- VALID` matches how it has been declared since signed revaluations were first
-- allowed: existing rows are not re-scanned, only new writes are checked.
ALTER TABLE "money_events"
  DROP CONSTRAINT IF EXISTS "money_events_amount_nonneg";

ALTER TABLE "money_events"
  ADD CONSTRAINT "money_events_amount_nonneg"
  CHECK (
    "amount" >= 0
    OR "event_type" = 'asset_update'::"MoneyEventType"
    OR "event_type" = 'asset_quantity_adjustment'::"MoneyEventType"
  ) NOT VALID;

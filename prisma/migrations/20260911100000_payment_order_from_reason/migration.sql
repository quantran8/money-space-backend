-- Which paywall sent a household to checkout.
--
-- Without it, "which wall converts?" is unanswerable: we know which plans sold
-- and nothing about what prompted the purchase, so there is no way to tell a
-- paywall worth keeping from one nobody pays for.
--
-- NULL is a real answer rather than missing data — the plans page can be opened
-- with nothing refused — and it is ALWAYS null on a RevenueCat order, because an
-- in-app purchase arrives as a webhook with no order of ours to carry a reason.
-- That asymmetry is a known blind spot, not a gap to be filled by inventing a
-- value. See backend/memory/analytics.md.
--
-- TEXT, not an enum, for the same reason `plan_code` is one: an order is a
-- historical record, and retiring a paywall reason later must not make an old
-- receipt unreadable.
ALTER TABLE "payment_orders"
  ADD COLUMN "from_reason" TEXT;

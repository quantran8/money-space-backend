-- Asset sale (Bán tài sản) support. See backend/memory/asset-sale.md.

-- Asset lifecycle: an asset can be sold in full without being deleted, so it
-- keeps its history and money-event links. `active` is the default; `sold` marks
-- a fully-sold asset (kept for history); `closed` is reserved for matured
-- instruments.
CREATE TYPE "AssetStatus" AS ENUM ('active', 'sold', 'closed');

ALTER TABLE "assets"
  ADD COLUMN "status" "AssetStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "sold_at" TIMESTAMPTZ(6);

-- Sale fee on a money event. Meaningful for asset_sale (and later
-- asset_purchase); 0 for every other event type. `amount` stays the gross
-- proceeds; the receiving wallet is credited amount - fee_amount.
ALTER TABLE "money_events"
  ADD COLUMN "fee_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "money_events"
  ADD CONSTRAINT "money_events_fee_amount_check" CHECK ("fee_amount" >= 0);

-- Resolved sold quantity / value for an asset_sale, so editing or cancelling
-- the event can restore exactly what the sale removed from the asset's position
-- (market assets store the quantity; manual assets store the value). NULL for
-- every non-sale event.
ALTER TABLE "money_events"
  ADD COLUMN "sold_quantity" DECIMAL(20,8),
  ADD COLUMN "sold_value" DECIMAL(14,2);

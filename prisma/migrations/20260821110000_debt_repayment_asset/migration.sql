-- Default wallet a debt is expected to be repaid from.
--
-- Nullable on purpose: a debt is not tied to one wallet. The household repays
-- from whichever cash/bank wallet suits them that month, so this only pre-fills
-- the generated repayment events; the wallet is still chosen when a payment is
-- confirmed and may differ.
ALTER TABLE "debts" ADD COLUMN "repayment_asset_id" UUID;

ALTER TABLE "debts"
  ADD CONSTRAINT "debts_repayment_asset_id_fkey"
  FOREIGN KEY ("repayment_asset_id") REFERENCES "assets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "debts_repayment_asset_id_idx" ON "debts"("repayment_asset_id");

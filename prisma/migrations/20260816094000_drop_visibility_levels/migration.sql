-- Visibility levels are no longer part of the product. Every household member
-- sees the same record details; removing these presentation-only columns does
-- not change any financial values or ownership/responsibility metadata.
ALTER TABLE "assets" DROP COLUMN IF EXISTS "visibility_level";
ALTER TABLE "cashflow_events" DROP COLUMN IF EXISTS "visibility_level";
ALTER TABLE "money_events" DROP COLUMN IF EXISTS "visibility_level";
ALTER TABLE "attention_items" DROP COLUMN IF EXISTS "visibility_level";
ALTER TABLE "snapshot_asset_values" DROP COLUMN IF EXISTS "visibility_level";

DROP TYPE IF EXISTS "VisibilityLevel";

-- v3.1 §17: freeze the asset's CLASSIFICATION alongside its value.
--
-- A snapshot already froze each asset's value, name, type and liquidity. But if
-- an asset later changes from `household` to `personal_private`, or changes
-- holder, a past snapshot would silently start meaning something different when
-- re-read. Freezing the classification keeps old snapshots honest.
--
-- MUST run after 20260812092000 (needs assets.financial_nature to copy from).

ALTER TABLE "snapshot_asset_values"
  ADD COLUMN IF NOT EXISTS "financial_nature" "FinancialNature",
  ADD COLUMN IF NOT EXISTS "holder_member_id" UUID,
  ADD COLUMN IF NOT EXISTS "privacy_owner_member_id" UUID;

-- Backfill from the current asset. This is the best available approximation for
-- rows written before the freeze existed; going forward the snapshot writer
-- sets these at creation time.
UPDATE "snapshot_asset_values" sav
   SET "financial_nature"        = a."financial_nature",
       "holder_member_id"        = a."holder_member_id",
       "privacy_owner_member_id" = a."privacy_owner_member_id"
  FROM "assets" a
 WHERE a."id" = sav."asset_id"
   AND sav."financial_nature" IS NULL;

-- Any orphan (asset hard-deleted) falls back to the default.
UPDATE "snapshot_asset_values"
   SET "financial_nature" = 'household'
 WHERE "financial_nature" IS NULL;

ALTER TABLE "snapshot_asset_values"
  ALTER COLUMN "financial_nature" SET NOT NULL,
  ALTER COLUMN "financial_nature" SET DEFAULT 'household';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_asset_values_holder_member_id_fkey') THEN
    ALTER TABLE "snapshot_asset_values"
      ADD CONSTRAINT "snapshot_asset_values_holder_member_id_fkey"
      FOREIGN KEY ("holder_member_id") REFERENCES "household_members"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_asset_values_privacy_owner_member_id_fkey') THEN
    ALTER TABLE "snapshot_asset_values"
      ADD CONSTRAINT "snapshot_asset_values_privacy_owner_member_id_fkey"
      FOREIGN KEY ("privacy_owner_member_id") REFERENCES "household_members"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_asset_values_value_nonneg') THEN
    ALTER TABLE "snapshot_asset_values"
      ADD CONSTRAINT "snapshot_asset_values_value_nonneg" CHECK ("value" >= 0);
  END IF;
END $$;

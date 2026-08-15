-- Drop the second disclosure axis and the privacy-ownership column.
--
-- `financial_nature` existed to answer "whose money is this", but the only
-- value that ever ran any logic was `personal_private`, and its only effect was
-- the exclusion rule removed in the same change. The other three
-- (household / personal_included / managed_for_household) were behaviourally
-- identical to each other and could not even be set through the API — no DTO
-- field, no column in the asset INSERT/UPDATE.
--
-- `privacy_owner_member_id` recorded who owned the right to keep a record
-- private. With no private level there is no such right, and the column was
-- NULL on every row in every table. `holder_member_id` is deliberately KEPT:
-- who is responsible for the money is a different question from who may see it.
--
-- NOTE on snapshots: `snapshot_asset_values` freezes classification so that
-- reclassifying an asset cannot silently rewrite what a past snapshot meant
-- (§17). Dropping two of those frozen columns does erase history — accepted
-- here because every existing row is 'household'/NULL, so no information is
-- lost, and the erasure is itself recorded in audit_logs below.
--
-- Order matters: the child table goes before `assets`, and both before the type.

INSERT INTO "audit_logs" (id, household_id, actor_id, action, entity_type, entity_id, metadata)
SELECT gen_random_uuid(), h.id, NULL, 'household.schema_migrated', 'household', h.id,
       jsonb_build_object(
         'migration', '20260815120100_drop_financial_nature_and_privacy_owner',
         'droppedColumns', jsonb_build_array('financial_nature', 'privacy_owner_member_id'),
         'note', 'Frozen snapshot classification reduced; all affected rows were household/NULL.')
FROM "households" h
WHERE h.deleted_at IS NULL;

ALTER TABLE "snapshot_asset_values"
  DROP CONSTRAINT IF EXISTS "snapshot_asset_values_privacy_owner_member_id_fkey",
  DROP COLUMN IF EXISTS "privacy_owner_member_id",
  DROP COLUMN IF EXISTS "financial_nature";

DROP INDEX IF EXISTS "assets_household_id_financial_nature_idx";
DROP INDEX IF EXISTS "assets_privacy_owner_member_id_idx";
ALTER TABLE "assets"
  DROP CONSTRAINT IF EXISTS "assets_privacy_owner_member_id_fkey",
  DROP COLUMN IF EXISTS "privacy_owner_member_id",
  DROP COLUMN IF EXISTS "financial_nature";

DROP INDEX IF EXISTS "cashflow_events_privacy_owner_member_id_idx";
ALTER TABLE "cashflow_events"
  DROP CONSTRAINT IF EXISTS "cashflow_events_privacy_owner_member_id_fkey",
  DROP COLUMN IF EXISTS "privacy_owner_member_id";

DROP INDEX IF EXISTS "money_events_privacy_owner_member_id_idx";
ALTER TABLE "money_events"
  DROP CONSTRAINT IF EXISTS "money_events_privacy_owner_member_id_fkey",
  DROP COLUMN IF EXISTS "privacy_owner_member_id";

ALTER TABLE "attention_items"
  DROP CONSTRAINT IF EXISTS "attention_items_privacy_owner_member_id_fkey",
  DROP COLUMN IF EXISTS "privacy_owner_member_id";

DROP TYPE IF EXISTS "FinancialNature";

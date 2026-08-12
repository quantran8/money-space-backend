-- v3.1 §21 + §30: attention items gain a privacy owner, and the polymorphic
-- target enum renames `upcoming_payment` → `cashflow_event` ahead of the table
-- rename in the next migration.
--
-- RENAME VALUE is transaction-safe (unlike ADD VALUE + immediate use), and no
-- code reads this value today — mapAttentionItem only surfaces title/reason/level.
--
-- Note: `attention_items` still has NO `deleted_at`, by design. `status =
-- dismissed` IS the gone state; a second delete flag would be a conflicting
-- source of truth.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'RelatedObjectType' AND e.enumlabel = 'upcoming_payment'
  ) THEN
    ALTER TYPE "RelatedObjectType" RENAME VALUE 'upcoming_payment' TO 'cashflow_event';
  END IF;
END $$;

ALTER TABLE "attention_items"
  ADD COLUMN IF NOT EXISTS "privacy_owner_member_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attention_items_privacy_owner_member_id_fkey') THEN
    ALTER TABLE "attention_items"
      ADD CONSTRAINT "attention_items_privacy_owner_member_id_fkey"
      FOREIGN KEY ("privacy_owner_member_id") REFERENCES "household_members"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

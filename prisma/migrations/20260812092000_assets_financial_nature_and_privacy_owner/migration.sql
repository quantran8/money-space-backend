-- v3.1 §11 + §30: the two axes that DERIVE whether an asset counts toward the
-- shared household picture, plus the privacy owner.
--
-- There is deliberately NO `included_in_household_calculation` column. Whether
-- a record counts is computed from (financial_nature, visibility_level) — see
-- src/common/utils/shared-calculation.ts. A stored flag would drift from the
-- two axes that actually decide it.
--
-- `privacy_owner_member_id` is distinct from `created_by` (who typed it in) and
-- from `holder_member_id` (who holds the money). It is who owns the RIGHT to
-- keep the record private.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FinancialNature') THEN
    CREATE TYPE "FinancialNature" AS ENUM (
      'household',
      'personal_included',
      'managed_for_household',
      'personal_private'
    );
  END IF;
END $$;

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "financial_nature" "FinancialNature" NOT NULL DEFAULT 'household',
  ADD COLUMN IF NOT EXISTS "privacy_owner_member_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_privacy_owner_member_id_fkey') THEN
    ALTER TABLE "assets"
      ADD CONSTRAINT "assets_privacy_owner_member_id_fkey"
      FOREIGN KEY ("privacy_owner_member_id") REFERENCES "household_members"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- §30 legacy fallback, applied ONCE here rather than on every read: existing
-- private assets get their privacy owner resolved from whoever created them.
-- New private rows must set privacy_owner_member_id explicitly (enforced in the
-- service) — `created_by` is not a valid substitute going forward, because the
-- person who enters a record is often not the person it belongs to.
UPDATE "assets" a
   SET "privacy_owner_member_id" = m."id"
  FROM "household_members" m
 WHERE a."visibility_level" = 'private'
   AND a."privacy_owner_member_id" IS NULL
   AND m."household_id" = a."household_id"
   AND m."user_id" = a."created_by"
   AND m."deleted_at" IS NULL;

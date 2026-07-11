-- PR5c: HouseholdMember gains `status` (active/invited) + soft-delete.
--
-- The entity needed a `status` (has the member accepted, or are they still just
-- invited?) but the table had no column, so `mapMember` hardcoded 'active'.
-- Adds the enum + column, plus `deleted_at` so removing a member soft-deletes
-- (keeps FK references from audit / owned assets & debts intact).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MemberStatus') THEN
    CREATE TYPE "MemberStatus" AS ENUM ('active', 'invited');
  END IF;
END $$;

ALTER TABLE "household_members"
  ADD COLUMN IF NOT EXISTS "status" "MemberStatus" NOT NULL DEFAULT 'active';
ALTER TABLE "household_members"
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "household_members_household_live_idx"
  ON "household_members" ("household_id", "deleted_at");

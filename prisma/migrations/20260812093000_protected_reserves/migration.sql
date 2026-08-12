-- v3.1 §19C: protected reserves — money the household has decided to keep
-- untouched (emergency fund, a deposit already promised to something).
--
-- This is a CONSTRAINT on the forecast, not necessarily a separate account:
-- flexible money = available money − protected reserve. It is what makes
-- "how much can we move without breaking what we promised ourselves" answerable.
--
-- The MVP UI shows one main reserve, but the table supports many so a second
-- one later is a data insert, not a migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReserveStatus') THEN
    CREATE TYPE "ReserveStatus" AS ENUM ('active', 'archived');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "protected_reserves" (
  "id"           UUID PRIMARY KEY,
  "household_id" UUID NOT NULL,
  "name"         TEXT NOT NULL,
  "amount"       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  "status"       "ReserveStatus" NOT NULL DEFAULT 'active',
  "note"         TEXT,
  "created_by"   UUID,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by"   UUID,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at"   TIMESTAMPTZ(6)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'protected_reserves_household_id_fkey') THEN
    ALTER TABLE "protected_reserves"
      ADD CONSTRAINT "protected_reserves_household_id_fkey"
      FOREIGN KEY ("household_id") REFERENCES "households"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'protected_reserves_created_by_fkey') THEN
    ALTER TABLE "protected_reserves"
      ADD CONSTRAINT "protected_reserves_created_by_fkey"
      FOREIGN KEY ("created_by") REFERENCES "profiles"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'protected_reserves_updated_by_fkey') THEN
    ALTER TABLE "protected_reserves"
      ADD CONSTRAINT "protected_reserves_updated_by_fkey"
      FOREIGN KEY ("updated_by") REFERENCES "profiles"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'protected_reserves_amount_nonneg') THEN
    ALTER TABLE "protected_reserves"
      ADD CONSTRAINT "protected_reserves_amount_nonneg" CHECK ("amount" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'protected_reserves_name_not_blank') THEN
    ALTER TABLE "protected_reserves"
      ADD CONSTRAINT "protected_reserves_name_not_blank" CHECK (btrim("name") <> '');
  END IF;
END $$;

-- Plain indexes (mirrored as @@index in schema.prisma so a squash keeps them).
CREATE INDEX IF NOT EXISTS "protected_reserves_household_id_status_idx"
  ON "protected_reserves" ("household_id", "status");
CREATE INDEX IF NOT EXISTS "protected_reserves_household_id_deleted_at_idx"
  ON "protected_reserves" ("household_id", "deleted_at");

-- Partial "live rows" index — the canonical read is
-- `household_id = ? AND deleted_at IS NULL AND status = 'active'`.
-- Mirrored by the two plain indexes above (Prisma cannot express partial).
CREATE INDEX IF NOT EXISTS "protected_reserves_household_live_idx"
  ON "protected_reserves" ("household_id") WHERE "deleted_at" IS NULL;

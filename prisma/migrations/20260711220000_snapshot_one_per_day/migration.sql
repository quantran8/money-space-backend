-- Auto-snapshot: one live snapshot per household per day.
--
-- Enforces "1 snapshot sống / ngày / household" so ensureTodaySnapshot's
-- INSERT ... ON CONFLICT upsert has a conflict target. Partial (WHERE deleted_at
-- IS NULL) so a day whose snapshot was soft-deleted can be recreated. Prisma
-- @@unique can't express a partial index, so it lives here.
CREATE UNIQUE INDEX IF NOT EXISTS "snapshots_one_per_day"
  ON "snapshots" ("household_id", "snapshot_date")
  WHERE "deleted_at" IS NULL;

-- Restore a household_id-leading index on `assets`.
--
-- Regression fix. The `assets` table had NO index whose leading column is
-- `household_id`, so the canonical list query
--     SELECT ... FROM assets
--     WHERE household_id = ? AND deleted_at IS NULL
--     ORDER BY created_at DESC
-- (findAssetsByHousehold — the hottest read path, powering the dashboard home
-- screen and every assets list/summary/detail/value-history/snapshot read) fell
-- back to a full sequential scan + sort of the ENTIRE assets table on every
-- call, growing with the total number of households in the system.
--
-- Root cause: the partial index `assets_household_live_idx`
-- (`ON assets(household_id) WHERE deleted_at IS NULL`) added in
-- 20260711150000_add_indexes_and_checks was silently dropped by the Prisma
-- re-init squash 20260712074514_init (schema.prisma cannot express a partial
-- WHERE index, and no plain household_id index was declared for Asset). The
-- squash preserved the analogous partial indexes for household_members and
-- money_event_categories but not for assets.
--
-- Two indexes are (re)created:
--   1. The plain composite `assets_household_id_created_at_idx` — matches the
--      `@@index([householdId, createdAt(sort: Desc)])` now declared on model
--      Asset in schema.prisma, so it survives the next re-init squash. Covers
--      both the WHERE household_id filter and the ORDER BY created_at DESC in a
--      single index (no seq-scan, no separate sort).
--   2. The smaller partial `assets_household_live_idx` (live rows only) — mirrors
--      the original PR1 index; the `WHERE deleted_at IS NULL` predicate matches
--      the query's soft-delete filter exactly, so the planner can use a tighter
--      index over just the non-deleted rows.
--
-- Idempotent (IF NOT EXISTS). On a populated production table, run the CREATE
-- INDEX statements with CONCURRENTLY (outside a transaction) to avoid a write
-- lock; they are written plainly here for the standard migrate path.

CREATE INDEX IF NOT EXISTS "assets_household_id_created_at_idx"
  ON "assets" ("household_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "assets_household_live_idx"
  ON "assets" ("household_id") WHERE "deleted_at" IS NULL;

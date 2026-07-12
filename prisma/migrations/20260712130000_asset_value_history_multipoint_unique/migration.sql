-- The old partial-unique index enforced ONE active value point per asset per day
-- (`(asset_id, valuation_date) WHERE deleted_at IS NULL`). That contradicts the
-- new model: each value-changing action appends its own point, so a single day
-- can hold several points (e.g. two revaluations, or an event + the AS_OF cache
-- row). Drop it and replace with two narrower partial-unique indexes that match
-- how `insertAssetValueHistory` upserts.

-- Drop the stale "one row per asset per day" unique index (added to the DB
-- directly, outside Prisma's tracked migrations).
DROP INDEX IF EXISTS "asset_valuations_asset_date_unique";

-- Event-linked points: at most one active point per (asset, money event). This
-- is the upsert key for money-event-driven and revaluation points.
CREATE UNIQUE INDEX "asset_value_history_asset_money_event_unique"
  ON "asset_value_history" ("asset_id", "money_event_id")
  WHERE "money_event_id" IS NOT NULL AND "deleted_at" IS NULL;

-- The unlinked "value now" cache row (money_event_id IS NULL): still at most one
-- active row per asset per date — this is the AS_OF row upsertCurrentValuation
-- keeps current.
CREATE UNIQUE INDEX "asset_value_history_asset_date_cache_unique"
  ON "asset_value_history" ("asset_id", "valuation_date")
  WHERE "money_event_id" IS NULL AND "deleted_at" IS NULL;

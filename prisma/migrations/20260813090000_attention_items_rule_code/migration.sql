-- v3.1 §29: attention items gain a machine-readable rule code and an explicit
-- dismissal stamp.
--
-- WHY `rule_code`
-- Most v3.1 attention signals are DERIVED from the forecast bundle at read time
-- (`cashflow_overdue`, `low_projected_balance`, `stale_data`, …) and are never
-- persisted — the condition can clear, and this table has no `deleted_at`, so a
-- stale persisted row would be indistinguishable from a user dismissal.
--
-- But a user must still be able to dismiss a derived signal. That dismissal is
-- stored as a TOMBSTONE row: `status = 'dismissed'` carrying the rule code (and
-- the related object, when the signal is about one). `GET /attention-items`
-- suppresses any derived signal matching a live tombstone. Without a column to
-- hold the code there is nothing to match on.
--
-- Stored items carry the code too, so one response shape covers both sources.
--
-- WHY `dismissed_at` / `dismissed_by`
-- `seen` and `resolved` already have their own timestamps; dismissal was
-- reusing neither, so "when was this dismissed" had no answer. Reusing
-- `resolved_at` would conflate "we dealt with it" with "don't show me this",
-- which are different facts about the household.

ALTER TABLE "attention_items"
  ADD COLUMN IF NOT EXISTS "rule_code" TEXT,
  ADD COLUMN IF NOT EXISTS "dismissed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "dismissed_by" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attention_items_dismissed_by_fkey') THEN
    ALTER TABLE "attention_items"
      ADD CONSTRAINT "attention_items_dismissed_by_fkey"
      FOREIGN KEY ("dismissed_by") REFERENCES "profiles"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill: every pre-v3.1 row was hand-created by a member, which is exactly
-- what `user_flagged` means. Written as a guarded UPDATE so a re-run is a no-op.
UPDATE "attention_items"
   SET "rule_code" = 'user_flagged'
 WHERE "rule_code" IS NULL;

-- The tombstone lookup: "which derived signals has this household dismissed".
-- Mirrored by `@@index([householdId, ruleCode])` in schema.prisma so a future
-- squash can't silently drop it.
CREATE INDEX IF NOT EXISTS "attention_items_household_id_rule_code_idx"
  ON "attention_items" ("household_id", "rule_code");

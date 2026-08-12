-- Indexes and CHECK constraints for `cashflow_events` (spec §32, §18).
-- Split from 20260812101000 because the table only exists after 20260812095000.
--
-- Plain indexes are mirrored as `@@index` in schema.prisma so a future squash
-- cannot silently drop them.

CREATE INDEX IF NOT EXISTS "cashflow_events_household_id_status_idx"
  ON "cashflow_events" ("household_id", "status");
CREATE INDEX IF NOT EXISTS "cashflow_events_household_id_direction_expected_date_idx"
  ON "cashflow_events" ("household_id", "direction", "expected_date");
CREATE INDEX IF NOT EXISTS "cashflow_events_household_id_certainty_idx"
  ON "cashflow_events" ("household_id", "certainty");
CREATE INDEX IF NOT EXISTS "cashflow_events_owner_member_id_idx"
  ON "cashflow_events" ("owner_member_id");
CREATE INDEX IF NOT EXISTS "cashflow_events_financial_goal_id_idx"
  ON "cashflow_events" ("financial_goal_id");
CREATE INDEX IF NOT EXISTS "cashflow_events_planned_asset_id_idx"
  ON "cashflow_events" ("planned_asset_id");
CREATE INDEX IF NOT EXISTS "cashflow_events_privacy_owner_member_id_idx"
  ON "cashflow_events" ("privacy_owner_member_id");

-- The forecast's hot read: live events in a date window for one household.
-- Mirrored by the plain [household_id, expected_date] index in schema.prisma.
CREATE INDEX IF NOT EXISTS "cashflow_events_household_live_idx"
  ON "cashflow_events" ("household_id", "expected_date") WHERE "deleted_at" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashflow_events_amount_nonneg') THEN
    ALTER TABLE "cashflow_events" ADD CONSTRAINT "cashflow_events_amount_nonneg" CHECK (
      "amount" >= 0
      AND ("last_completed_amount" IS NULL OR "last_completed_amount" >= 0)
    ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashflow_events_name_not_blank') THEN
    ALTER TABLE "cashflow_events" ADD CONSTRAINT "cashflow_events_name_not_blank"
      CHECK (btrim("name") <> '') NOT VALID;
  END IF;

  -- A recurrence that ends before it starts would silently produce zero
  -- occurrences and quietly vanish from the forecast.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashflow_events_recurrence_end_valid') THEN
    ALTER TABLE "cashflow_events" ADD CONSTRAINT "cashflow_events_recurrence_end_valid"
      CHECK ("recurrence_end_date" IS NULL OR "recurrence_end_date" >= "expected_date") NOT VALID;
  END IF;

  -- §18: outgoing money is either required or planned; incoming has no
  -- requirement (you don't "have to" receive money). NOT VALID so one dirty
  -- legacy row cannot block the release — new/updated rows are checked.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashflow_events_requirement_rule') THEN
    ALTER TABLE "cashflow_events" ADD CONSTRAINT "cashflow_events_requirement_rule" CHECK (
      ("direction" = 'outgoing' AND "requirement" IS NOT NULL)
      OR ("direction" = 'incoming' AND "requirement" IS NULL)
    ) NOT VALID;
  END IF;
END $$;

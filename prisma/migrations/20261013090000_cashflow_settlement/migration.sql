-- Cashflow settlement + note-based matching. See memory/cashflow-settlement.md.

ALTER TABLE "money_events"
  ADD COLUMN "occurrence_date" DATE,
  ADD COLUMN "settled_via"     TEXT,
  ADD COLUMN "settled_by"      UUID,
  ADD COLUMN "settled_at"      TIMESTAMPTZ(6),
  ADD COLUMN "match_rule_id"   UUID;

-- One live piece of evidence per occurrence.
CREATE UNIQUE INDEX "money_events_cashflow_occurrence_uniq"
  ON "money_events" ("cashflow_event_id", "occurrence_date")
  WHERE "deleted_at" IS NULL AND "occurrence_date" IS NOT NULL;

CREATE TABLE "cashflow_match_rules" (
  "id"                UUID PRIMARY KEY,
  "household_id"      UUID NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "cashflow_event_id" UUID NOT NULL REFERENCES "cashflow_events"("id") ON DELETE CASCADE,
  "phrase"            TEXT NOT NULL,
  "phrase_normalized" TEXT NOT NULL,
  "operator"          TEXT NOT NULL DEFAULT 'contains',
  "is_enabled"        BOOLEAN NOT NULL DEFAULT true,
  "created_by"        UUID NOT NULL REFERENCES "profiles"("id"),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at"        TIMESTAMPTZ(6)
);

CREATE INDEX "cashflow_match_rules_active_idx"
  ON "cashflow_match_rules" ("household_id")
  WHERE "deleted_at" IS NULL AND "is_enabled";
CREATE INDEX "cashflow_match_rules_event_idx" ON "cashflow_match_rules" ("cashflow_event_id");

ALTER TABLE "bank_notification_events"
  ADD COLUMN "suggested_cashflow_event_id" UUID,
  ADD COLUMN "match_status"                TEXT,
  ADD COLUMN "match_reason"                TEXT;

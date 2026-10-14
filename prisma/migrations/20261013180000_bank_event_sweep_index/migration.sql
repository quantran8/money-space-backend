-- Cross-household sweeps filter on status + reason, never household_id.
-- See memory/bank-sync.md (Giữ chân OUT).
CREATE INDEX IF NOT EXISTS "bank_notification_events_sweep_idx"
  ON "bank_notification_events" ("status", "status_reason", "received_at");

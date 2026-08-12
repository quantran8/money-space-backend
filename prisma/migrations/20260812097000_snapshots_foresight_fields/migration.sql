-- v3.1 §10: freeze the foresight context into each snapshot.
--
-- A snapshot is a frozen picture. Without these columns a past snapshot could
-- only be re-explained by re-running today's forecast against today's reserves
-- and events — which is exactly the silent mutation §26 forbids
-- ("snapshot đã tạo thì không đổi ngầm").
--
-- Every NOT NULL column here ships with a DEFAULT. That is not decoration: any
-- INSERT that lists columns explicitly would fail otherwise.

ALTER TABLE "snapshots"
  ADD COLUMN IF NOT EXISTS "protected_reserve_amount" NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "forecast_horizon_days"    INTEGER        NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS "upcoming_income_amount"   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "upcoming_outgoing_amount" NUMERIC(14, 2) NOT NULL DEFAULT 0,
  -- Nullable AND legitimately negative: a projected shortfall is the signal the
  -- whole product exists to surface. §10 explicitly forbids a `>= 0` CHECK on
  -- these two — do not "tidy" that up later.
  ADD COLUMN IF NOT EXISTS "lowest_projected_balance" NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS "flexible_money"           NUMERIC(14, 2);

-- Deliberately NO backfill. Historical snapshots were taken before any forecast
-- existed, so they genuinely have no foresight context. Reconstructing one from
-- today's data would be inventing history.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshots_foresight_nonneg') THEN
    ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_foresight_nonneg" CHECK (
      "protected_reserve_amount" >= 0
      AND "upcoming_income_amount" >= 0
      AND "upcoming_outgoing_amount" >= 0
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshots_horizon_positive') THEN
    ALTER TABLE "snapshots"
      ADD CONSTRAINT "snapshots_horizon_positive" CHECK ("forecast_horizon_days" > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "snapshots_household_id_created_at_idx"
  ON "snapshots" ("household_id", "created_at" DESC);

-- Retire protected reserves.
--
-- The reserve was meant to be a floor on the forecast: flexible money was
-- `<liquid figure> − Σ active reserves`, so "how much can we spend without
-- breaking what we promised ourselves" had an answer. It never became one.
--
-- The only surviving write path was step 5 of onboarding. The screen that could
-- edit or clear a reserve was never mounted, so PATCH and DELETE had no caller
-- at all: a household that typed a number once was stuck with it forever while
-- it kept subtracting from the figure the Home screen leads with. The three
-- `protected_reserve.*` audit actions were never wired to a write site either.
--
-- The table also carried both `deleted_at` and an `archived` status — two
-- disappearance mechanisms on one row, which this repo forbids precisely
-- because it makes "is this row live?" ambiguous.
--
-- With the reserve gone, flexible money is a pure function of what the
-- household holds and what it owes. `lowest_projected_balance` IS the horizon
-- figure now; there is no second name for it.

DROP TABLE IF EXISTS "protected_reserves";

DROP TYPE IF EXISTS "ReserveStatus";

-- Derived attention signals are recomputed on every read; the only trace a
-- retired rule leaves is its dismissal tombstone. Left behind, those rows would
-- keep a dismissal alive for a signal that can never fire, and `dismissDerived`
-- would answer 400 for a payload it used to accept.
DELETE FROM "attention_items" WHERE "rule_code" = 'reserve_at_risk';

-- The snapshot froze the reserve so a past picture stayed reproducible. Since
-- the concept is gone the column can only ever hold history for a thing that no
-- longer exists — and its two derived reasons (`reserve_significantly_breached`,
-- `forecast_near_reserve`) are gone with it. A handful of past snapshots that
-- read `tight` or `watch` because of a reserve will read `on_track` from now on.
-- That is the accepted cost of the removal, recorded here so it is not later
-- mistaken for a bug.
--
-- The CHECK is composite, so it must be rebuilt rather than left to follow the
-- column. §10 still forbids a `>= 0` CHECK on `lowest_projected_balance` and
-- `flexible_money` — a projected shortfall is the signal, not an error.
ALTER TABLE "snapshots" DROP CONSTRAINT IF EXISTS "snapshots_foresight_nonneg";

ALTER TABLE "snapshots" DROP COLUMN IF EXISTS "protected_reserve_amount";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshots_foresight_nonneg') THEN
    ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_foresight_nonneg" CHECK (
      "upcoming_income_amount" >= 0
      AND "upcoming_outgoing_amount" >= 0
    );
  END IF;
END $$;

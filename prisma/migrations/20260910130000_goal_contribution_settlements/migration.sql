-- The month-end close on a goal's contribution shares.
--
-- `goal_asset_allocations.allocated_amount` stops being a figure the household
-- typed once and becomes a SUB-LEDGER: the wallet is one account at the bank,
-- the shares are the household's own division of it, and the division moves when
-- money does. "TCB holds 30tr, 20tr of it is the car's" becomes "TCB holds 40tr,
-- 30tr of it is the car's" the month they put 10tr in.
--
-- The month-end job rewrites that column, which makes it a running figure with
-- no memory. This table is the memory: without it, a closed month becomes
-- unrecoverable the moment the next one closes.
--
-- Why the close is read off the BALANCE rather than off a transaction: a
-- transfer labelled "10tr for the car" states an intention. If 4tr came back out
-- of the same wallet on the 20th, the car did not get 10tr that month, and
-- recording 10tr would record something that did not happen. The month is left
-- to run, and what the goal actually kept is read once the month is over.
--
-- Append-only. A row is the household's record of what a month came to; a re-run
-- of the job for a month already closed leaves the original alone rather than
-- restating history. The unique index below is what enforces that, and it is
-- also what makes the job safe to retry after a crash mid-run.
CREATE TABLE "goal_contribution_settlements" (
  "id"                    UUID          NOT NULL,
  "household_id"          UUID          NOT NULL,
  "financial_goal_id"     UUID          NOT NULL,
  "allocation_id"         UUID          NOT NULL,
  "asset_id"              UUID          NOT NULL,
  "month"                 VARCHAR(7)    NOT NULL,
  "opening_amount"        DECIMAL(14,2) NOT NULL,
  "target_amount"         DECIMAL(14,2) NOT NULL,
  "closing_amount"        DECIMAL(14,2) NOT NULL,
  "actual_amount"         DECIMAL(14,2) NOT NULL,
  "wallet_balance"        DECIMAL(14,2) NOT NULL,
  "short_on_wallet"       BOOLEAN       NOT NULL DEFAULT false,
  "needs_share_decision"  BOOLEAN       NOT NULL DEFAULT false,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "goal_contribution_settlements_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "goal_contribution_settlements"
  ADD CONSTRAINT "goal_contribution_settlements_household_id_fkey"
  FOREIGN KEY ("household_id") REFERENCES "households"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "goal_contribution_settlements"
  ADD CONSTRAINT "goal_contribution_settlements_financial_goal_id_fkey"
  FOREIGN KEY ("financial_goal_id") REFERENCES "financial_goals"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "goal_contribution_settlements"
  ADD CONSTRAINT "goal_contribution_settlements_allocation_id_fkey"
  FOREIGN KEY ("allocation_id") REFERENCES "goal_asset_allocations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- `YYYY-MM`, so a malformed month cannot quietly become a month that sorts
-- wrong. Every reader orders by this string.
ALTER TABLE "goal_contribution_settlements"
  ADD CONSTRAINT "goal_contribution_settlements_month_format"
  CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- One close per share per month. This is what makes the job idempotent: a
-- second run for a month already settled conflicts instead of writing a second
-- row that would double the month's contribution.
CREATE UNIQUE INDEX "goal_contribution_settlements_allocation_month_key"
  ON "goal_contribution_settlements" ("allocation_id", "month");

CREATE INDEX "goal_contribution_settlements_household_id_month_idx"
  ON "goal_contribution_settlements" ("household_id", "month");

CREATE INDEX "goal_contribution_settlements_financial_goal_id_month_idx"
  ON "goal_contribution_settlements" ("financial_goal_id", "month");

-- The monthly pace belongs to the wallets, not to the goal.
--
-- `financial_goals.planned_monthly_contribution` was a number typed on the goal
-- with nothing behind it: a household could declare 10tr a month for a goal
-- backed entirely by gold, and the plan named no account the money would come
-- out of. The pace panel then compared that figure against wallet movement it
-- had no relationship to.
--
-- A goal is fed THROUGH a wallet — that is the only way money is ever put into
-- one — so the pace is declared on the wallet share and the goal's figure is the
-- SUM of them. "10tr a month" becomes "6tr out of the salary account, 4tr in
-- cash": the same total, now attached to the accounts that have to produce it.
--
-- Two consequences, both deliberate:
--
--   * `financial_goals.planned_monthly_contribution` STAYS, and stops being an
--     input. It becomes the maintained sum of the wallet figures, rewritten by
--     `GoalsService` in the same transaction as any allocation write. It is kept
--     because every goal surface shows the pace — the goals list, the dashboard,
--     the forecast — and none of them otherwise reads `goal_asset_allocations`
--     at all; summing on read would put a join on all of them to recompute a
--     number that changes only when an allocation is written.
--   * Every goal must own at least one `cash`/`bank_account` share. That rule
--     spans `goal_asset_allocations` and `assets`, so no CHECK can see it —
--     `GoalsService` enforces it at write time, on create and when a share is
--     removed. Goals that predate this migration are left as they are: a rule
--     about what may be WRITTEN must not delete history, and such a goal simply
--     reports no pace until a wallet is added.

-- 1. The per-wallet pace.
ALTER TABLE "goal_asset_allocations"
  ADD COLUMN "monthly_contribution" DECIMAL(14, 2);

-- Only a contribution share may carry one, and never a negative one. A `holding`
-- share is value already accumulated — it is not fed monthly, and a pace on it
-- would be counted into a total that the pace panel then measures against wallet
-- movement only, reporting a shortfall every month for money nobody planned to
-- move.
ALTER TABLE "goal_asset_allocations"
  ADD CONSTRAINT "goal_asset_allocations_monthly_contribution_role"
  CHECK (
    "monthly_contribution" IS NULL
    OR ("role" = 'contribution' AND "monthly_contribution" >= 0)
  );

-- 2. Carry each goal's declared pace onto ONE of its wallets.
--
-- The whole amount lands on the earliest wallet share rather than being split
-- across them, because the split is information the old column never held and
-- inventing one would put figures in front of the household that they never
-- typed. The goal's total is preserved exactly, which is what the pace panel
-- reads; a household that wants it spread edits the shares.
--
-- A goal with no wallet share keeps nothing. It never had a pace that could be
-- kept — its progress moved with the gold price — so the figure disappearing is
-- the panel stopping a monthly verdict on a plan nobody could follow.
WITH primary_wallet AS (
  SELECT DISTINCT ON (a."financial_goal_id")
    a."id" AS allocation_id,
    g."planned_monthly_contribution" AS amount
  FROM "goal_asset_allocations" a
  JOIN "financial_goals" g ON g."id" = a."financial_goal_id"
  JOIN "assets" s ON s."id" = a."asset_id"
  WHERE a."deleted_at" IS NULL
    AND g."deleted_at" IS NULL
    AND g."planned_monthly_contribution" IS NOT NULL
    AND g."planned_monthly_contribution" > 0
    AND a."role" = 'contribution'
    AND s."type" IN ('cash', 'bank_account')
  ORDER BY a."financial_goal_id", a."created_at", a."id"
)
UPDATE "goal_asset_allocations" a
SET "monthly_contribution" = w.amount
FROM primary_wallet w
WHERE a."id" = w.allocation_id;

-- 3. Make the goal-level figure agree with the wallets it now summarises.
--
-- After step 2 the two are equal for every goal that has a wallet share. The
-- goals that do NOT are the ones to fix: their declared pace named no account it
-- could come from, nothing carried it forward, and leaving the old number would
-- have the mirror reporting a pace no row underneath it claims. NULL is the
-- honest reading — no wallet, no pace — and it is what a recompute from the
-- allocations produces from here on.
UPDATE "financial_goals" g
SET "planned_monthly_contribution" = (
  SELECT SUM(a."monthly_contribution")
  FROM "goal_asset_allocations" a
  WHERE a."financial_goal_id" = g."id"
    AND a."deleted_at" IS NULL
    AND a."role" = 'contribution'
    AND a."monthly_contribution" IS NOT NULL
)
WHERE g."deleted_at" IS NULL;

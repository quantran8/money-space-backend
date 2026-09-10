-- A contribution share is always a fixed amount.
--
-- `kind` answers one question: does this claim track the asset's price? That is
-- a question only a HOLDING can be asked. Gold has a price, so "50% of my gold"
-- is a standing arrangement that follows it — the household states the share
-- once and never touches it again while the price moves underneath.
--
-- A contribution wallet has no price. Its balance moves only when money is paid
-- in or spent, so "50% of this wallet" is not an arrangement that follows
-- anything: it is a figure that silently re-derives itself every time the
-- household buys groceries.
--
-- That is not a cosmetic distinction, because the pace panel is built on the
-- contribution shares alone. `resolveContributionProgressAmount` reads a percent
-- share as a percentage of the wallet's CURRENT balance, so a month's delta
-- stopped meaning "how much went into the goal" and started meaning "how much
-- did this wallet move". Spending 2tr of money that was never promised to the
-- goal reported the household as 2tr behind a pace they had in fact kept — the
-- exact failure the `role` column was introduced to remove, reintroduced through
-- the other column.
--
-- The web and mobile forms had been setting `kind = 'percent'` with `percent =
-- 100` whenever a share was made a contribution, so this is not a theoretical
-- state: it is what the product wrote by default.
--
-- Three steps: convert the rows, repair the goal baselines they corrupted, then
-- make the state unreachable.

-- 1. Convert every contribution share to the fixed amount it is worth today.
--
-- Today's value is the honest reading. `allocationValue` already resolves a
-- percent claim to `min(balance * percent/100, balance)`, so this writes down
-- the number the application was ALREADY reporting for these rows — it changes
-- what the figure will do TOMORROW (stay put, rather than follow the balance),
-- not what it says now. Nothing on any screen moves the day this runs.
--
-- Capped at the asset's value for the same reason the runtime caps it: a claim
-- may never assert more money than the account holds.
UPDATE "goal_asset_allocations" ga
SET
  "kind" = 'fixed',
  "allocated_amount" = ROUND(
    LEAST(
      a."current_value" * LEAST(ga."percent", 100) / 100,
      a."current_value"
    ),
    2
  ),
  "percent" = NULL
FROM "assets" a
WHERE a."id" = ga."asset_id"
  AND ga."role" = 'contribution'
  AND ga."kind" = 'percent'
  AND ga."deleted_at" IS NULL;

-- A soft-deleted row cannot be repaired against a live asset value and is never
-- read by the pace panel, but it still has to satisfy the CHECK below. Convert
-- it to a fixed zero: the claim is gone, and 0 is what a retracted claim is
-- worth.
UPDATE "goal_asset_allocations"
SET "kind" = 'fixed', "allocated_amount" = 0, "percent" = NULL
WHERE "role" = 'contribution'
  AND "kind" = 'percent'
  AND "deleted_at" IS NOT NULL;

-- 2. Repair the creation baselines these rows corrupted.
--
-- `financial_goals.baseline_contribution_amount` is frozen at creation as the
-- sum of the contribution shares' worth — it is the left-hand side of the first
-- month's subtraction, standing in for the previous close a brand-new goal does
-- not have.
--
-- For a goal created through the broken form, that sum was the wallet's ENTIRE
-- balance rather than what the household said was already set aside. The first
-- month was then measured against a starting line far above the truth, and
-- reported a shortfall for money that had never been promised.
--
-- Recomputed from the converted rows above. This is the same definition the
-- service uses, applied to figures that are now meaningful. Goals with no
-- contribution share, and goals whose baseline was never recorded, are left
-- alone: NULL there means "no baseline", which the panel already reads
-- correctly as "cannot say" rather than as zero.
UPDATE "financial_goals" g
SET "baseline_contribution_amount" = repaired."amount"
FROM (
  SELECT
    ga."financial_goal_id" AS goal_id,
    ROUND(SUM(LEAST(ga."allocated_amount", a."current_value")), 2) AS "amount"
  FROM "goal_asset_allocations" ga
  JOIN "assets" a ON a."id" = ga."asset_id"
  WHERE ga."role" = 'contribution'
    AND ga."deleted_at" IS NULL
  GROUP BY ga."financial_goal_id"
) AS repaired
WHERE g."id" = repaired."goal_id"
  AND g."baseline_contribution_amount" IS NOT NULL
  -- Only goals the broken form actually touched. A goal whose shares were all
  -- entered as amounts has a correct baseline already, and rewriting it would
  -- move a frozen figure for no reason.
  AND EXISTS (
    SELECT 1
    FROM "goal_asset_allocations" x
    WHERE x."financial_goal_id" = g."id"
      AND x."role" = 'contribution'
      AND x."deleted_at" IS NULL
      AND x."allocated_amount" IS NOT NULL
  );

-- 3. Make the state unreachable.
--
-- `GoalsService.normalizeAllocationShape` refuses this combination with a
-- message the household can act on, which is where the error SHOULD surface.
-- This CHECK is the backstop: the invariant is a property of the data, not of
-- one code path, and a future writer that has not been taught the rule must not
-- be able to reintroduce it.
ALTER TABLE "goal_asset_allocations"
  ADD CONSTRAINT "goal_asset_allocations_contribution_is_fixed"
  CHECK ("role" <> 'contribution' OR "kind" = 'fixed');

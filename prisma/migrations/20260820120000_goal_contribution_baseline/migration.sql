-- What a goal STARTED with, so its first month can report a figure.
--
-- The create form asks the household for two different things about a wallet
-- share: how much of that wallet is already behind the goal ("số tiền có sẵn"),
-- and how much goes in each month ("tiền góp hàng tháng"). The first was written
-- into `goal_asset_allocations.allocated_amount` and then never recorded as a
-- STARTING POINT, so nothing downstream could tell the two apart afterwards.
--
-- `buildGoalMonthlyProgress` measures a month as the difference between two
-- frozen points. A goal created this month has only one point — today's — so
-- there was nothing to subtract from and the first month reported `—`. That was
-- read as "we cannot say whether you kept the pace", when the household HAD
-- said: 20tr was the opening balance, not this month's saving.
--
-- Freezing the opening contribution figure here gives that first month its
-- missing left-hand side. The month then reads 0 while nothing has moved yet,
-- and climbs as money actually goes in — never crediting the goal with a balance
-- that was declared as already there.
--
-- Deliberately NOT a synthetic `snapshots` row. A snapshot means "the household
-- looked on this day"; writing a fake one to carry one number would put a day
-- into every history that reads snapshots — the timeline, freshness, the asset
-- panels — for a day nobody reviewed anything.
ALTER TABLE "financial_goals"
  ADD COLUMN "baseline_contribution_amount" DECIMAL(14, 2);

-- Baselines for goals that already exist.
--
-- Their opening balance is the `contribution` shares' fixed amounts, which is
-- exactly what the create form wrote and what a baseline frozen at creation
-- would have held. Percent shares are skipped: they resolve against a live asset
-- value, so "40% of the savings account" has no fixed opening figure to freeze
-- and any number here would be today's value pretending to be creation day's.
--
-- Only goals whose FIRST month is still running are backfilled. A goal with
-- closed months already has a real previous point to subtract from, and adding a
-- baseline underneath it would change history that has been reported correctly
-- for months.
WITH first_close AS (
  SELECT sgv."financial_goal_id" AS goal_id
  FROM "snapshot_goal_values" sgv
  JOIN "snapshots" s ON s."id" = sgv."snapshot_id"
  WHERE TO_CHAR(s."snapshot_date", 'YYYY-MM') < TO_CHAR(NOW(), 'YYYY-MM')
  GROUP BY sgv."financial_goal_id"
),
opening AS (
  SELECT a."financial_goal_id" AS goal_id,
         SUM(a."allocated_amount") AS amount
  FROM "goal_asset_allocations" a
  WHERE a."deleted_at" IS NULL
    AND a."role" = 'contribution'
    AND a."kind" = 'fixed'
    AND a."allocated_amount" IS NOT NULL
  GROUP BY a."financial_goal_id"
)
UPDATE "financial_goals" g
SET "baseline_contribution_amount" = o.amount
FROM opening o
WHERE g."id" = o.goal_id
  AND g."deleted_at" IS NULL
  AND g."id" NOT IN (SELECT goal_id FROM first_close);

-- Clean up rows left pointing at a DELETED asset.
--
-- Assets are soft-deleted (`assets.deleted_at`), so the `ON DELETE` rules on
-- every relation below never fire: deleting an asset left its goal claims, its
-- scheduled events, its debts and its own detail rows behind, each naming a row
-- no read would ever return again. A goal went on listing a wallet the
-- household had removed, contributing nothing to its progress and showing no
-- name, because the asset resolved to nothing.
--
-- The application no longer creates these — `AssetsService.deleteAsset` refuses
-- while anything still points at the asset, and clears every reference in one
-- transaction once the household confirms. This is the one-off cleanup for
-- orphans created before that existed.
--
-- Written to be re-runnable: every statement is bounded by "still live, but its
-- asset is not", so a second run matches nothing.

-- 1. Goal claims over a deleted asset.
--
-- Soft-deleted rather than hard-deleted, matching how the app removes a claim
-- and keeping the row readable in the journal.
UPDATE "goal_asset_allocations" a
SET "deleted_at" = now()
FROM "assets" s
WHERE a."asset_id" = s."id"
  AND s."deleted_at" IS NOT NULL
  AND a."deleted_at" IS NULL;

-- 2. The pace mirror on every goal that just lost a claim.
--
-- `financial_goals.planned_monthly_contribution` is a MIRROR of the goal's
-- surviving contribution claims. Step 1 removed claims without touching it, so
-- an affected goal would otherwise keep advertising a monthly pace partly
-- funded by a wallet that no longer exists.
--
-- NULL (not 0) when NOTHING DECLARED a figure: null means "no target", while 0
-- would mean the household planned to save nothing and would earn them a
-- shortfall verdict every month. Only `contribution` claims count — a holding
-- reprices on its own and was never going to be paid in.
--
-- "Nothing declared" is deliberately not the same as "the declared figures sum
-- to zero". A household that explicitly says 0 has answered the question, and
-- `resolvePlannedMonthlyContribution` — the resolver every allocation write in
-- the app ends in — keeps that 0. So the DECLARED-ness is tracked separately
-- (COUNT of rows carrying a figure) rather than inferred from the sum with
-- NULLIF, which would silently turn a deliberate 0 into "never asked".
UPDATE "financial_goals" g
SET "planned_monthly_contribution" = sub."pace"
FROM (
  SELECT
    live."financial_goal_id" AS goal_id,
    CASE
      WHEN COUNT(*) FILTER (
        WHERE live."role" = 'contribution'
          AND live."monthly_contribution" IS NOT NULL
          AND live."monthly_contribution" >= 0
      ) = 0 THEN NULL
      ELSE COALESCE(
        SUM(live."monthly_contribution") FILTER (
          WHERE live."role" = 'contribution'
            AND live."monthly_contribution" IS NOT NULL
            AND live."monthly_contribution" >= 0
        ),
        0
      )
    END AS pace
  FROM "goal_asset_allocations" live
  WHERE live."deleted_at" IS NULL
  GROUP BY live."financial_goal_id"
) sub
WHERE g."id" = sub.goal_id
  AND g."deleted_at" IS NULL
  AND g."planned_monthly_contribution" IS DISTINCT FROM sub."pace";

-- A goal whose every claim is now gone keeps no pace at all: the subquery above
-- has no row for it, so it is handled separately.
UPDATE "financial_goals" g
SET "planned_monthly_contribution" = NULL
WHERE g."deleted_at" IS NULL
  AND g."planned_monthly_contribution" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "goal_asset_allocations" a
    WHERE a."financial_goal_id" = g."id"
      AND a."deleted_at" IS NULL
  );

-- 3. Cashflow events pointing at a deleted asset.
--
-- The events themselves stay: an expected bill is a fact about money that still
-- has to move, and it does not stop being true because the wallet it was going
-- to come out of was removed. Only the pointer goes, so the household is asked
-- to name a new wallet rather than being shown one that no longer exists.
UPDATE "cashflow_events" e
SET "planned_asset_id" = NULL
FROM "assets" s
WHERE e."planned_asset_id" = s."id" AND s."deleted_at" IS NOT NULL;

UPDATE "cashflow_events" e
SET "settlement_asset_id" = NULL
FROM "assets" s
WHERE e."settlement_asset_id" = s."id" AND s."deleted_at" IS NOT NULL;

UPDATE "cashflow_events" e
SET "last_completed_asset_id" = NULL
FROM "assets" s
WHERE e."last_completed_asset_id" = s."id" AND s."deleted_at" IS NOT NULL;

-- 4. Debts pointing at a deleted asset. Same reasoning: money owed is owed
-- whether or not the wallet it was borrowed into still exists.
UPDATE "debts" d
SET "received_to_asset_id" = NULL
FROM "assets" s
WHERE d."received_to_asset_id" = s."id" AND s."deleted_at" IS NOT NULL;

UPDATE "debts" d
SET "repayment_asset_id" = NULL
FROM "assets" s
WHERE d."repayment_asset_id" = s."id" AND s."deleted_at" IS NOT NULL;

-- 5. Money events pointing at a deleted asset.
--
-- `deleteAsset` has always unlinked these, so this only catches rows from
-- before that, but it costs one bounded statement to be sure.
UPDATE "money_events" m
SET "from_asset_id" = NULL
FROM "assets" s
WHERE m."from_asset_id" = s."id" AND s."deleted_at" IS NOT NULL;

UPDATE "money_events" m
SET "to_asset_id" = NULL
FROM "assets" s
WHERE m."to_asset_id" = s."id" AND s."deleted_at" IS NOT NULL;

-- 6. The asset's own detail rows.
--
-- A live market position on a deleted asset kept that ticker in the market-data
-- poll universe forever — the provider was billed, on every refresh, to price a
-- holding no household still has.
UPDATE "asset_market_positions" p
SET "deleted_at" = now()
FROM "assets" s
WHERE p."asset_id" = s."id"
  AND s."deleted_at" IS NOT NULL
  AND p."deleted_at" IS NULL;

UPDATE "asset_calculation_terms" c
SET "deleted_at" = now()
FROM "assets" s
WHERE c."asset_id" = s."id"
  AND s."deleted_at" IS NOT NULL
  AND c."deleted_at" IS NULL;

-- 7. Valuation history of a deleted asset.
UPDATE "asset_valuations" v
SET "deleted_at" = now()
FROM "assets" s
WHERE v."asset_id" = s."id"
  AND s."deleted_at" IS NOT NULL
  AND v."deleted_at" IS NULL;

-- Tell "money we put in" apart from "value we hold".
--
-- A goal's progress is the sum of its allocations, and that is right: it answers
-- "how much do we have towards the 500tr". But the monthly pace panel asked a
-- DIFFERENT question with the same number — "did we keep our 10tr-a-month?" —
-- and gold repricing answered it wrongly in both directions:
--
--   * gold up 10tr in a month nobody contributed to  → "đủ nhịp"
--   * gold down 10tr in a month they saved 10tr      → "thiếu"
--
-- The fix is not to measure market moves more cleverly; it is to stop measuring
-- them at all. A wallet has no market price — its balance moves only when the
-- household takes money in or spends it — so a pace computed from wallets alone
-- needs no separation of price from principal. There is nothing to separate.
--
-- Which allocations count is the HOUSEHOLD's answer, not a rule derived from the
-- asset type. A household may hold two wallets, one for spending and one set
-- aside for this goal; deriving the role from `type` would count both. The type
-- only seeds the default.

-- 1. The role of an allocation.
CREATE TYPE "GoalAllocationRole" AS ENUM ('contribution', 'holding');

ALTER TABLE "goal_asset_allocations"
  ADD COLUMN "role" "GoalAllocationRole" NOT NULL DEFAULT 'holding';

-- Wallets are what money is contributed through, so they seed as the
-- contribution source; everything else is value already held. Existing rows get
-- the same treatment a new row would.
UPDATE "goal_asset_allocations" a
SET "role" = 'contribution'
FROM "assets" s
WHERE s."id" = a."asset_id"
  AND s."type" IN ('cash', 'bank_account');

-- 2. Freeze the contribution figure alongside the total.
--
-- Deliberately NOT backfilled for existing snapshots. It is computable from
-- `snapshot_asset_values` plus today's allocations — and that is exactly the
-- problem: adding a wallet to a goal now would retroactively change what June's
-- pace "was". Frozen-not-recomputed is why `snapshot_goal_values` exists at all
-- (see 20260819160000); recomputing here would undo that reasoning.
--
-- Rows written before this migration keep 0. Readers must distinguish "0 because
-- nothing was recorded" from "0 because nothing went in" — a total > 0 with a
-- contribution of 0 means the former, and the UI shows "—" rather than a figure
-- that would report a household as having missed months it may well have kept.
ALTER TABLE "snapshot_goal_values"
  ADD COLUMN "contribution_progress_amount" DECIMAL(14, 2) NOT NULL DEFAULT 0;

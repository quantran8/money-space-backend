-- Which goal gets the money when one wallet cannot feed them all.
--
-- A wallet can back several goals, and each of them declares its own
-- `monthly_contribution` with nothing checking the total. Two goals could each
-- say "20tr a month out of TCB" against an account with 2tr free, and both were
-- told they were on track for 2tr — 4tr of pace against 2tr of money.
--
-- `financial_goals.priority` settles most of it: a `high` goal is fed before a
-- `medium` one. What it cannot settle is a TIE. Two goals at the same priority
-- sharing one wallet have no order between them, and picking one by creation
-- date would be the product deciding which of the household's plans matters
-- more — a decision it has no standing to make.
--
-- So the household is asked, and this is where the answer lives: the share of
-- the wallet's remaining monthly room this goal takes when its priority group
-- cannot all be paid in full.
--
-- It is NOT the contribution itself. `monthly_contribution` stays the declared
-- amount and remains the cap; this only decides how a SHORTFALL is split, and
-- is never consulted while the wallet can cover everyone.
ALTER TABLE "goal_asset_allocations"
  ADD COLUMN "share_percent" DECIMAL(5, 2);

-- Only a contribution share can carry one. A `holding` is value already
-- accumulated — nothing is paid into it on a schedule, so it never competes for
-- a wallet's monthly room and a split figure on it would describe nothing.
ALTER TABLE "goal_asset_allocations"
  ADD CONSTRAINT "goal_asset_allocations_share_percent_role"
  CHECK (
    "share_percent" IS NULL
    OR (
      "role" = 'contribution'
      AND "share_percent" > 0
      AND "share_percent" <= 100
    )
  );

-- No backfill, deliberately.
--
-- NULL means "the household was never asked", which is NOT the same as 100.
-- Writing 100 onto every existing row would have each goal claiming the whole
-- wallet, and the first tie would be settled by a number nobody chose. Left
-- NULL, a tie among rows with no share falls back to splitting in proportion to
-- the paces they declared — an even-handed reading that survives until the
-- household says otherwise, and one the UI can flag as "still yours to decide".

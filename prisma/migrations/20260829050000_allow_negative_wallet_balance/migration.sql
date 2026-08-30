-- Let a WALLET balance go negative.
--
-- Editing a money event replays every wallet it touches from that wallet's
-- opening balance, so a corrected back-dated inflow can leave the events that
-- follow it overdrawn. That state is recorded rather than clamped: clamping at 0
-- silently ate the difference and made an edit non-invertible (editing 5tr → 1tr
-- → 5tr did not return the original balance), and a negative balance is the
-- truthful signal that recorded spending exceeds recorded income. The app
-- surfaces it as a warning; see memory wallet-replay-on-edit.
--
-- Scope is deliberately narrow where the schema allows it:
--
-- * `assets.current_value` — negative ONLY for `cash` / `bank_account`. A house,
--   a gold holding or a fund going negative is still nonsense, and those are
--   priced from a quantity/price that cannot produce one.
--
-- * `asset_valuations.value` — a plain `>= 0` had to go entirely. A CHECK cannot
--   subquery, and this table carries no asset type of its own, so there is no
--   way to say "negative only for wallets" here. The narrower guarantee lives on
--   `assets` above, which is the row a wallet balance is actually read from;
--   these are history points mirroring it.
--
-- A CHECK cannot be amended in place, so each is dropped and recreated.
-- `NOT VALID` skips re-scanning existing rows — every stored row already
-- satisfies the wider predicate, since it satisfied the stricter one.
ALTER TABLE "assets"
  DROP CONSTRAINT IF EXISTS "assets_current_value_nonneg";

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_current_value_nonneg"
  CHECK (
    "current_value" >= 0
    OR "type" = 'cash'::"AssetType"
    OR "type" = 'bank_account'::"AssetType"
  ) NOT VALID;

ALTER TABLE "asset_valuations"
  DROP CONSTRAINT IF EXISTS "asset_valuations_value_nonneg";

-- A snapshot freezes what the wallets were worth on the day it was taken, so an
-- overdrawn wallet has to survive being frozen — otherwise the nightly snapshot
-- starts failing for the whole household. This table DOES carry the asset's type,
-- so the narrow rule applies here as it does on `assets`.
ALTER TABLE "snapshot_asset_values"
  DROP CONSTRAINT IF EXISTS "snapshot_asset_values_value_nonneg";

ALTER TABLE "snapshot_asset_values"
  ADD CONSTRAINT "snapshot_asset_values_value_nonneg"
  CHECK (
    "value" >= 0
    OR "asset_type" = 'cash'::"AssetType"
    OR "asset_type" = 'bank_account'::"AssetType"
  ) NOT VALID;

-- `total_liquid` sums the wallets, so an overdrawn wallet can pull the household
-- total below zero. The other totals keep their floor: savings, long-term assets
-- and debt have no negative reading, and `attention_count` is a count.
-- (`lowest_projected_balance` and `flexible_money` were already left out of this
-- constraint for the same reason — both may legitimately be negative.)
ALTER TABLE "snapshots"
  DROP CONSTRAINT IF EXISTS "snapshots_totals_nonneg";

ALTER TABLE "snapshots"
  ADD CONSTRAINT "snapshots_totals_nonneg"
  CHECK (
    "total_savings" >= 0
    AND "total_long_term_assets" >= 0
    AND "total_debt" >= 0
    AND "attention_count" >= 0
  ) NOT VALID;

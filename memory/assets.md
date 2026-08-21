# Assets feature

Where the household's money/assets sit, and their current value. The valuation maths live in [[asset-valuation]]; this file covers the CRUD/summary flow.

## Overview

CRUD over `Asset`, with a derived current value. On create, `valuationMode` defaults from the asset type (see [[asset-valuation]]).

## Rules / flow

- **Discriminated form**: visible fields switch on the selected type's valuation mode. Per-mode conditional validation via `.superRefine`:
  - `manual` → requires `value`.
  - `market_priced` → requires `symbol` + `quantity ≥ 0` + `purchasePrice` (original purchase price of 1 unit; see [[asset-valuation]]).
  - `formula_calculated` → requires `principal` + `interestRate ≥ 0` + `startDate`.
- `toAsset()` converts raw form → typed `Asset`, returning `null` on incomplete inputs.
- **Same-symbol accumulation**: creating a market-priced asset first looks for
  an active position in the household with the same `assetClass + symbol`
  (case-insensitive). If found, it adds quantity to that asset and recalculates
  `purchasePrice` as a quantity-weighted average instead of creating a duplicate
  `assets` / `asset_market_positions` row. `lastPrice` is preserved. A fully
  sold historical asset is not reused; buying it again starts a new lifecycle.
- **Liquidity summary**: assets are grouped/summed into 3 buckets — "Có thể dùng ngay" (`usable_now`), "Tiết kiệm & dự phòng" (`not_immediately_usable`), "Dài hạn" (`long_term`). `snapshotTotal` = sum of the three (`computeLiquidityTotals` on backend).
- **Which bucket an asset lands in** = `liquidityForAsset(type, countsAsFlexible)`:
  - `assets.counts_as_flexible` is the household's explicit answer to "does this count towards flexible money", `NULL` = "no answer, follow the type". It is the ONE liquidity input a client may send (`CreateAssetDto.countsAsFlexible`); the bucket itself is still never posted.
  - `true` → `usable_now` for any type (gold they would genuinely sell this month). `false` on a `cash` / `bank_account` → `not_immediately_usable` (money held for someone else) — never `long_term`. `false` on a type that was never flexible changes nothing.
  - A flag that merely restates the type's default is stored as `NULL` (`normalizeCountsAsFlexible`), so an asset nobody decided about keeps following its type, including after a type change.
  - **The override is materialized into the `liquidity` column, not consulted separately.** Forecast starting balance, dashboard, assets summary and snapshot lines all read that one column, so they cannot disagree — see the warning in CLAUDE.md and `shared-figures.spec.ts`. The `assets_liquidity_matches_type` CHECK now encodes `liquidity = f(type, counts_as_flexible)` and still makes any other combination unstorable (migration `20260816120000_asset_counts_as_flexible`).
- **Already owned vs. just bought** (`CreateAssetDto.fundingAssetId`) — two
  different acts that the create form must tell apart, because they move net
  worth differently:
  - **Đã có sẵn** (no funding wallet, the default) — the household is declaring
    something it holds, e.g. gold bought in 2020. Net worth **rises**: they are
    no richer, just newly honest about what they have. No money event, no wallet
    touched.
  - **Vừa mua** (a wallet id) — a purchase. Net worth **stays put**: money left
    the wallet and came back as the asset. Logs an `asset_purchase` **outflow**
    carrying `from_asset_id` and debits that wallet.

  Before this existed every entry behaved as the first, so buying 100tr of gold
  appeared to create 100tr out of nothing. Both create paths honour it — a
  brand-new asset (`logInitialPurchase`) and adding to an existing position
  (`logAdditionalPurchase`).

  - **The amount charged is the cost basis, not the live value**
    (`resolvePurchaseCost`): a market position costs `quantity × purchasePrice`.
    Buying 1 lượng at 80tr while the price says 82tr must take 80tr out of the
    wallet — charging market price would invent a loss that never happened.
  - **The wallet must cover it** (`assertFundingWalletCovers`, before the write
    transaction). Unlike an expense — recorded after the fact, possibly against
    a stale balance — a purchase is declared as it happens, so an amount the
    wallet cannot cover means the balance is out of date or the money came from
    elsewhere. Letting it through would hit the `Math.max(0, …)` floor in
    `debitManualAsset`, leaving the wallet at 0 while the asset kept its full
    value — re-inflating net worth, the very bug this removes. Spending a wallet
    to exactly 0 is allowed; only overspending is rejected.
  - **Not a column on `assets`** — it describes ONE acquisition, not the asset.
    Buying more of the same position later would have no single value to store.
    Purchase history lives in `money_events`, next to `asset_sale`.
  - Offered only for types a household actually buys (`canBePurchased`): gold,
    crypto, stock, real estate, foreign currency. Paying for a wallet out of a
    wallet is a transfer, and a saving deposit has its own funding flow.
  - Entry points: the asset form, and the **"Mua tài sản"** quick action on the
    events page — which opens that form already set to "vừa mua", mirroring
    "Bán tài sản". See [[money-events]].
- **Delete** = soft-delete (`deletedAt`) + also delete the asset's valuations + unlink the asset from any money events.
- **Status / lifecycle**: `status` (`active` | `sold` | `closed`, default `active`) + `soldAt`. Distinct from `deletedAt`: a **sold** asset is kept (quantity/value 0) for history, excluded from the liquidity buckets and net worth, but still listed. Selling an asset (reducing the position + closing it on a full sale) is driven by an `asset_sale` money event — see [[asset-sale]]. `AssetsService.sellPosition` / `reverseSalePosition` apply/undo the position change.
- **Wallet balance moves**: `cash` and `bank_account` are "wallet" assets that hold a free spendable balance (`WALLET_ASSET_TYPES` in `assets.service.ts`). `AssetsService.creditManualAsset` / `debitManualAsset` add/subtract from the wallet's `manualValue` and re-upsert its valuation; a debit floors at 0 (never negative). These are **no-ops for any other asset type** (stock, gold, saving deposit, …), which are valued from price/formula, not a stored cash balance. Callers: every money event with a `fromAsset`/`toAsset` (see [[money-events]]), and debt borrow/delete (indirectly, via the events layer — see [[debts]]).

- **What a goal has claimed of it** (`GET /households/:id/assets/:assetId/goal-usage`).
  An asset's balance is not the same as money the household can use: most of an
  account can already be promised to a goal. The relationship used to be visible
  only from the goal's side, so answering "can I use this?" meant opening every
  goal in turn.
  - Served by `GoalsService.assetGoalUsage` from a controller in the GOALS module
    mounted under the assets path: `GoalsService` already imports `AssetsService`,
    so the reverse module edge would be a cycle.
  - **Every role is listed**, `holding` as well as `contribution` — gold behind a
    goal is spoken for just as much as cash is.
  - `freeAmount` uses `sumAllocatedAgainstAsset`, the same subtraction the write
    path enforces, so what the page reports as free is exactly what a new claim
    would be allowed to take. See [[goals]].

- **What a goal has claimed of it** (`GET /households/:id/assets/:assetId/goal-usage`).
  An asset's balance is not the same as money the household can use: most of an
  account can already be promised to a goal. The relationship used to be visible
  only from the goal's side, so answering "can I use this?" meant opening every
  goal in turn.
  - Served by `GoalsService.assetGoalUsage` from a controller in the GOALS module
    mounted under the assets path: `GoalsService` already imports `AssetsService`,
    so the reverse module edge would be a cycle.
  - **Every role is listed**, `holding` as well as `contribution` — gold behind a
    goal is spoken for just as much as cash is.
  - `freeAmount` uses `sumAllocatedAgainstAsset`, the same subtraction the write
    path enforces, so what the page reports as free is exactly what a new claim
    would be allowed to take. See [[goals]].

## Sub-entities (backend)

- `AssetMarketPosition` — symbol / quantity / quoteCurrency / `purchasePrice` (original purchase/cost price) / `lastPrice` + `lastPriceAt` (latest manual or API market price) for market-priced assets.
- `AssetCalculationTerm` — principal / rate / dates / compounding (for formula-based interest instruments).
- `AssetValuation` — point-in-time value with method/confidence; optionally linked to a market price, FX rate, or calc term.

## Where it lives in code

- **frontend-web**: `src/features/assets/{model/assets.ts, model/assets.types.ts, model/assets-form.ts, api/assets.repository.ts, hooks/use-assets.ts, hooks/use-assets-page.ts}`.
- **backend**: `src/modules/assets/` (`assets.service.ts`, `entities/{asset,asset-valuation,calculation-term,market-position}.entity.ts`, `repositories/prisma-assets.repository.ts`).
- **mobile-app**: to be ported.

## Enums

`AssetType` (15), `ValuationMode`, `AssetLiquidity`, `AssetClass`, `CalculationType = saving_deposit | bond | loan_receivable | certificate_of_deposit`.

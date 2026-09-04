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
  - A flag that merely restates the type's default is stored as `NULL` (`normalizeCountsAsFlexible`), so an asset nobody decided about keeps following its type.
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
- **Identity is fixed once the asset exists** — `type`, and for a market-priced
  holding its `marketPosition.symbol` / `assetClass`, cannot be edited.
  `AssetsService.assertIdentityUnchanged` refuses a differing value with a 400;
  the forms POST the whole record back, so an unchanged value still passes.
  - **Why:** the row carries its own history — valuations, `money_events`, goal
    allocations, price points. Re-typing cash into a stock, or repointing FPT at
    HPG, would hang all of that off something the household never owned, and
    every past figure would then describe an asset that no longer exists.
  - The remedy is the act that actually happened: a wrong entry is deleted and
    entered again; a position that changed hands is **sold** and the new one
    **bought**. Same reasoning as the read-only quantity on edit — see the
    buy-more / adjust-quantity routes.
  - Both forms render `type` (and `symbol`) as a **locked field** on edit — the
    disabled-input recipe, not a hidden field: the user still has to see what
    they are editing.
- **Delete** = soft-delete (`deletedAt`), and — because a soft delete fires no
  database cascade — the app must clear everything pointing at the asset itself.
  - **Refused by default.** While a live goal claim, cashflow event or debt still
    names the asset, `DELETE .../assets/:assetId` returns **409** with an
    `impact` payload rather than deleting. `GET .../assets/:assetId/delete-impact`
    returns the same shape as a plain read, so the confirmation dialog can state
    the cost before the household decides.
  - **`?cascade=true`** is that decision. In one transaction it soft-deletes the
    asset, its valuations, its market position and calculation term, and its goal
    allocations; unlinks it from money events, cashflow events
    (`planned` / `settlement` / `last_completed`) and debts; then **recomputes
    `financial_goals.planned_monthly_contribution`** for every affected goal from
    the claims that survive. The events, debts and goals themselves all survive —
    only the pointer goes.
  - **Why it matters:** every one of those relations declares an `ON DELETE`
    rule, and none of them can fire against a soft delete. Before this, deleting
    an asset left goals listing a wallet the household had removed — no name, no
    value, and its share of the progress silently zero. See [[goals]].
  - A goal may be left with **no contribution wallet at all** — that is allowed
    (the alternative was blocking the delete), and the `goal_without_wallet`
    attention signal is what says so. See [[attention-items]].
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

## Sellability has one definition

`SELLABLE_ASSET_TYPES` lives on the asset entity/model, not on a service, so the
forecast's pure what-if engine can read it without importing a Nest provider
(`AssetsService.SELLABLE_ASSET_TYPES` re-exports the same set). A real sale and
a simulated one can never disagree about what can be sold.

What-if's funding step narrows it twice more, both on the client: the asset must
not be `usable_now` (a wallet is transferred from, not sold), and `real_estate`
is hidden because a partial property sale is priced by area and cannot be
expressed as "bán 300tr". It also requires a known `currentValue` — a
market-priced asset with no quote has no figure the household could check.

`ForecastLiquidSource` carries `type` for this; the forecast bundle already
loads every active asset, so it costs no extra query.

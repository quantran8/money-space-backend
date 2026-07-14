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
- **Delete** = soft-delete (`deletedAt`) + also delete the asset's valuations + unlink the asset from any money events.
- **Status / lifecycle**: `status` (`active` | `sold` | `closed`, default `active`) + `soldAt`. Distinct from `deletedAt`: a **sold** asset is kept (quantity/value 0) for history, excluded from the liquidity buckets and net worth, but still listed. Selling an asset (reducing the position + closing it on a full sale) is driven by an `asset_sale` money event — see [[asset-sale]]. `AssetsService.sellPosition` / `reverseSalePosition` apply/undo the position change.
- **Wallet balance moves**: `cash` and `bank_account` are "wallet" assets that hold a free spendable balance (`WALLET_ASSET_TYPES` in `assets.service.ts`). `AssetsService.creditManualAsset` / `debitManualAsset` add/subtract from the wallet's `manualValue` and re-upsert its valuation; a debit floors at 0 (never negative). These are **no-ops for any other asset type** (stock, gold, saving deposit, …), which are valued from price/formula, not a stored cash balance. Callers: every money event with a `fromAsset`/`toAsset` (see [[money-events]]), and debt borrow/delete (indirectly, via the events layer — see [[debts]]).

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

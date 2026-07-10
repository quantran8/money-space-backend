# Asset valuation engine (core domain)

The heart of the app. Every asset's current value is **derived**, never free-typed. Related: [[assets]], [[market-data]], [[snapshots-and-networth]].

## Overview

Each asset `type` maps **deterministically** to a `valuationMode` and a default `liquidity` bucket via lookup tables. **The user must NOT free-pick the valuation mode — derive it from the type.**

## Type → valuation mode

| Mode | Asset types |
|---|---|
| `manual` | cash, bank_account, real_estate, insurance, investment, other |
| `formula_calculated` | saving_deposit, certificate_of_deposit, bond, loan_receivable |
| `market_priced` | gold, stock, fund, crypto, foreign_currency |

## Type → default liquidity

| Liquidity | Asset types |
|---|---|
| `usable_now` | cash, bank_account |
| `not_immediately_usable` | saving_deposit, certificate_of_deposit, bond, loan_receivable, foreign_currency, other |
| `long_term` | gold, stock, fund, crypto, real_estate, insurance, investment |

## The three valuation modes (`computeCurrentValue(asset, asOf)` → VND)

Single dispatch entry point. Returns VND, or `null`/`0` when a price is unknown.

- **`manual`** → `manualValue ?? 0`.
- **`market_priced`** → `quantity × marketPrice × fxRateToVnd(quoteCurrency)`.
  - Quote matched by (assetClass, symbol), case-insensitive.
  - Frontend returns `null` if no known price; backend returns `0`.
- **`formula_calculated`** → **simple accrued interest** (non-compounding):
  ```
  current_value = principal + principal × (rate/100) × elapsedYears
  elapsedYears  = daysBetween(startDate, effectiveEnd) / 365
  effectiveEnd  = min(maturityDate, asOf)   // accrual FREEZES at maturity
  ```
  - `computeMaturityValue(term)` = principal + full-term simple interest (for display).

## FX

`fxRateToVnd(base)` finds a base→VND rate, **defaults to 1 if missing**. Currently stubbed (`fxToVnd → 1`).

## State cleanup invariant (`normalizeAsset`, backend)

Exactly one valuation source per asset — changing mode clears the others:
- `manual` → clears marketPosition + calculationTerm; defaults manualValue = 0.
- `market_priced` → clears manualValue + calculationTerm.
- `formula_calculated` → clears manualValue + marketPosition.

## Valuation persistence

`upsertCurrentValuation` (backend) recomputes via `computeCurrentValue` and writes/updates an `AssetValuation` row dated `AS_OF`, mapping mode → method:
`manual → manual`, `market_priced → market_price_api`, `formula_calculated → formula_calculated`.

## Where it lives in code

- **frontend-web**: `src/features/assets/model/assets.ts` (`valuationModeForType`, `defaultLiquidityForType`, `computeCurrentValue`, `computeMaturityValue`). Market pricing stubbed in `src/features/assets/api/assets.repository.ts` (`latestPrice→null`, `fxToVnd→1`).
- **backend**: `src/common/utils/money-space.utils.ts` (`VALUATION_MODE_BY_TYPE`, `computeCurrentValue`, `fxRateToVnd`, `computeLiquidityTotals`); `src/modules/assets/` (`normalizeAsset`, `upsertCurrentValuation`).
- **mobile-app**: to be ported — must mirror the same tables and formulas.

## Enums

- `ValuationMode = manual | market_priced | formula_calculated`
- `AssetLiquidity = usable_now | not_immediately_usable | long_term`
- `AssetClass = gold | crypto | stock | fund | foreign_currency`
- `AssetType` (15 values, listed in the two tables above)

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
- **`market_priced`** → `quantity × price × fxRateToVnd(quoteCurrency)`.
  - **Price source precedence**: user-entered `marketPosition.unitPrice` (if set)
    wins; otherwise fall back to the `quoteFor()` market-price cache lookup.
  - `unitPrice` is persisted on `asset_market_positions.unit_price` (nullable
    `Decimal(20,8)`); NULL means "use the market-price cache". Lets the user type
    the price of 1 unit (1 BTC, 1 share, 1 chỉ gold) — the MVP path while the
    pricing API is unwired.
  - Quote matched by (assetClass, symbol), case-insensitive.
  - Frontend returns `null` if no `unitPrice` and no known price; backend returns `0`.
- **`formula_calculated`** → **simple accrued interest** (non-compounding):
  ```
  current_value = principal + principal × (rate/100) × elapsedYears
  elapsedYears  = daysBetween(startDate, effectiveEnd) / 365
  effectiveEnd  = min(maturityDate, asOf)   // accrual FREEZES at maturity
  ```
  - `computeMaturityValue(term)` = principal + full-term simple interest (for display).

## Saving-deposit interest schedule, early withdrawal & auto-crediting

`saving_deposit` (a `formula_calculated` type) carries extra `CalculationTerm` fields:
- `interestPayment: 'end_of_term' | 'monthly'` — kỳ trả lãi. Persisted via the `payoutFrequency`
  column (`monthly↔monthly`, `end_of_term↔at_maturity`) in `asset_calculation_terms`.
- `nonTermRate` — lãi suất không kỳ hạn (annual %), **required for saving_deposit** (new
  `non_term_rate` column). Applied when withdrawing before maturity.
- `interestDestination: 'wallet' | 'principal'` (+ `receivingWalletId`) — where auto-credited
  interest lands (new `interest_destination` / `receiving_wallet_id` columns). `wallet` needs a
  cash/bank wallet; `principal` capitalizes (compounds).

**Display projections** (`money-space.utils.ts`, mirrored on the frontend, pure):
- `computeSavingOnTime(term)` — đúng hạn: `principal + principal × rate × termYears`.
- `computeSavingEarly(term, N)` — trước hạn ở tháng N:
  `actualInterest = principal × nonTermRate × N/12`; end_of_term `total = principal + actualInterest`;
  monthly claws back `principal × rate × N/12 − actualInterest` → `total = principal − clawback`.
- Display-only; never written to `asset_valuations`. Worked example (100tr, 6%, 12mo, non-term 0,2%):
  đúng hạn 106tr; @6mo → end_of_term 100,1tr, monthly 97,1tr (clawback 2,9tr).

**Auto-crediting interest** (idempotent, per-asset — the scalable shape, NO cron):
- `computeSavingInterestPeriods(term, asOf)` → due payouts. monthly: one per elapsed month,
  `principal × rate / 12`, capped at min(maturity, asOf). end_of_term: one full-term payout, due
  only once `asOf ≥ maturity`.
- `MoneyEventsService.accrueSavingInterestForAsset(householdId, assetId)` — for each not-yet-credited
  period, inside one `runInTransaction`: create a `money_event` (`type income`, `category 'interest'`,
  `fromAssetId = deposit`) + a dated `AssetValuation` via `AssetsService.writeSavingValuationAt`.
  `wallet` dest → `inflow` crediting `receivingWalletId` (normal wallet effect); `principal` dest →
  `neutral` event + `AssetsService.capitalizeSavingInterest` bumps the deposit's principal (compounds,
  running valuation tracked). Idempotency key: `(deposit, 'interest', periodEnd)` — existing dates
  skipped. `accrueHouseholdInterest` loops a household's active deposits.
- Endpoints (money-events controller, owned there to avoid an Assets↔MoneyEvents module cycle since
  MoneyEventsModule already imports AssetsModule): `POST …/money-events/accrue-interest` and
  `POST …/money-events/assets/:assetId/accrue-interest`. An external worker calls these.
- `computeCurrentValue` is **unchanged** — still returns the continuously-accrued value at `AS_OF`,
  ignoring `interestPayment`. The accrual flow is the separate source of dated valuation history +
  cash movement (deliberate MVP simplification).
- Code: `src/common/utils/money-space.utils.ts` (helpers), `src/modules/money-events/money-events.service.ts`
  (accrual), `src/modules/assets/assets.service.ts` (`getAssetEntity`, `writeSavingValuationAt`,
  `capitalizeSavingInterest`), `src/modules/assets/entities/calculation-term.entity.ts`, mapper +
  `prisma-assets.repository.ts` (persist), migrations `…_add_non_term_rate`, `…_add_interest_destination`.

## FX

`fxRateToVnd(base)`: VND→1; else finds a base→VND rate, returns **`null` if missing** (caller treats null as "value undefined" → `computeCurrentValue` returns 0, never mis-prices at rate 1). See [[market-data]].

## State cleanup invariant (`normalizeAsset`, backend)

Exactly one valuation source per asset — changing mode clears the others:
- `manual` → clears marketPosition + calculationTerm; defaults manualValue = 0.
- `market_priced` → clears manualValue + calculationTerm.
- `formula_calculated` → clears manualValue + marketPosition.

## Valuation persistence

`upsertCurrentValuation` (backend) recomputes via `computeCurrentValue` and writes/updates an `AssetValuation` row dated `AS_OF`, mapping mode → method:
`manual → manual`, `market_priced → market_price_api`, `formula_calculated → formula_calculated`. It also writes **lineage** (`source`: user/market_price_api/formula; `confidenceLevel`: high for manual, else medium; `marketPriceId`/`fxRateId`/`calculationTermId` stay null until a pricing-API writer + term-id-on-entity land) and — crucially — **writes the derived value back to `assets.current_value`** (`updateAssetCurrentValue`) so the cache is true for EVERY mode. Previously the plain create/update path only wrote `manualValue`, leaving `current_value` stale for market_priced/formula assets.

## Value history over time (asset detail page)

There is **no historical valuation series** — `upsertCurrentValuation` only ever
writes/updates a single `AssetValuation` row dated `AS_OF`, so `asset_valuations`
holds at most one point per asset. The asset detail page's "value over time"
chart (biến động theo thời gian) therefore **reconstructs** the series from the
money events that moved value in/out of the asset.

`AssetsService.getAssetValueHistory(householdId, assetId)` (backend) takes the
asset's current value and unwinds its money events (`findMoneyEventsByAsset` —
those where `fromAssetId` **or** `toAssetId` = the asset; no direct `assetId`
column on money events, linkage is from/to only), oldest → newest.
**How a value is recovered depends on the valuation mode:**

- **market_priced** (`buildMarketValueHistory`) — the value is
  `quantity × unit price` from `asset_market_positions`, so we price the
  **position**, not the cash the events moved. Rebuild the quantity held at each
  point (a sale = `+soldQuantity` going back; purchases set quantity directly on
  the asset, not via an event) and value every point at the current unit price
  (`currentValue / currentQuantity`). So a sale drops the line by
  `quantitySold × today's price`, **not** by the (possibly stale) cash the sale
  fetched. Quantity 0 → single flat current-value point.
- **manual / formula** (`buildCashValueHistory`) — no position, so unwind each
  event's signed cash contribution (in via `toAsset` = +, out via `fromAsset`
  = −), floored at 0.

Returns `{ currentValue, items: [{ date, value }], total }`, oldest → newest;
the last item is the current value. Duplicate dates collapsed (keep last).

Endpoint: `GET /api/households/:householdId/assets/:assetId/value-history`.
When an asset has no value-moving events, the series is a single current-value
point (the frontend chart shows an empty state below 2 points).

This is an MVP approximation; when a real snapshot/valuation history lands, swap
the derivation for a query over `asset_valuations` / `snapshot_asset_values`.

## Where it lives in code

- **frontend-web**: `src/features/assets/model/assets.ts` (`valuationModeForType`, `defaultLiquidityForType`, `computeCurrentValue`, `computeMaturityValue`). Market pricing stubbed in `src/features/assets/api/assets.repository.ts` (`latestPrice→null`, `fxToVnd→1`). Asset detail page + value-history chart: `src/features/assets/ui/asset-detail-page.tsx`, `use-asset-detail.ts` (reads the `value-history` endpoint), `asset-value-chart.tsx`.
- **backend**: `src/common/utils/money-space.utils.ts` (`VALUATION_MODE_BY_TYPE`, `computeCurrentValue`, `fxRateToVnd`, `computeLiquidityTotals`); `src/modules/assets/` (`normalizeAsset`, `upsertCurrentValuation`).
- **mobile-app**: to be ported — must mirror the same tables and formulas.

## Enums

- `ValuationMode = manual | market_priced | formula_calculated`
- `AssetLiquidity = usable_now | not_immediately_usable | long_term`
- `AssetClass = gold | crypto | stock | fund | foreign_currency`
- `AssetType` (15 values, listed in the two tables above)

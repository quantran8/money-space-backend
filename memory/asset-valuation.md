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
- Display-only; never written to `asset_value_history`. Worked example (100tr, 6%, 12mo, non-term 0,2%):
  đúng hạn 106tr; @6mo → end_of_term 100,1tr, monthly 97,1tr (clawback 2,9tr).

**Auto-crediting interest** (idempotent, per-asset — the scalable shape, NO cron):
- `computeSavingInterestPeriods(term, asOf)` → due payouts. monthly: one per elapsed month,
  `principal × rate / 12`, capped at min(maturity, asOf). end_of_term: one full-term payout, due
  only once `asOf ≥ maturity`.
- `MoneyEventsService.accrueSavingInterestForAsset(householdId, assetId)` — for each not-yet-credited
  period, inside one `runInTransaction`: create a `money_event` (`type income`, `category 'interest'`,
  `fromAssetId = deposit`) + a dated `AssetValueHistory` point via `AssetsService.writeSavingValuationAt`.
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

## Valuation persistence (`asset_value_history`)

The table is named **`asset_value_history`** (model `AssetValueHistory`, entity
`asset-value-history.entity.ts`) — renamed from `asset_valuations` to reflect
that it is a **time series** of an asset's value: one row per value-changing
action, not a single current valuation. Each row keeps the value, how it was
produced (`valuationMethod` / `source` / `confidenceLevel` / lineage ids) and —
new — a **`money_event_id`** linking it to the money event whose effect produced
it (`AssetValueHistory[] @relation("MoneyEventValueHistory")` on `MoneyEvent`).
Fields `valuationMode` (on the asset), `valuationDate`, `valuationMethod` keep
their names — the *concept* of a valuation point is unchanged.

`upsertCurrentValuation(asset, context?)` (backend) recomputes via
`computeCurrentValue`, then:
1. **Always** keeps the `AS_OF` "value now" row current (unlinked) — the point
   the dashboard reads — mapping mode → method (`manual → manual`,
   `market_priced → market_price_api`, `formula_calculated → formula_calculated`)
   and writing lineage (`source` user/market_price_api/formula; `confidenceLevel`
   high for manual else medium; `marketPriceId`/`fxRateId`/`calculationTermId`
   null until wired).
2. **Always** writes the derived value back to `assets.current_value`
   (`updateAssetCurrentValue`) so the cache is true for EVERY mode.
3. **When given a `ValuationContext`** (`{ moneyEventId, valuationDate }` — i.e.
   the change came from a money event) also appends/updates a **history point
   linked to that event**, keyed on `(moneyEventId, assetId)`, dated at the
   event's date. Two same-day events on one asset keep two distinct points;
   re-running the same event updates its own point in place.

**Actions that change an asset's value record a history point; most also record
a money event:**
- Money-event effects (income/expense/transfer credit/debit, `asset_sale`): the
  wallet/sale effect carries `context = { moneyEventId: event.id, valuationDate:
  event.isoDate }` (only on `apply` — see below).
- **Asset creation** (`createAsset`): logs **NO money event** — creating an asset
  moves no money through the ledger, it just establishes the starting value.
  `writeInitialValuation` writes ONE **unlinked** history point (dated AS_OF, no
  `moneyEventId`) plus the `current_value` cache. (`valuationLineage(asset)`
  derives method/source/confidence from the mode, shared with the linked-write
  path.)
- **Direct re-pricing on update** (user edits `manualValue`/`unitPrice`/
  `quantity`/term via *update* asset): `AssetsService.logRevaluation` writes a
  **neutral `asset_update` money event** (via
  `assetsRepository.insertRevaluationEvent`, `to_asset_id = asset`,
  `amount = new − old`) that moves no wallet and is excluded from
  income/expense, then the appended point links to it. Only fires when the value
  actually moved. AssetsService writes `money_events` directly (its repo) to
  avoid the Assets↔MoneyEvents module cycle. (Create used to do this too — it no
  longer does.)
- Saving-deposit interest: unchanged (`writeSavingValuationAt`, one dated point
  per credited period).

**Edit / delete of a money event keeps history consistent:**
- `reverse` (undo of old effect) carries **no** context — it is balance-only and
  writes no point (otherwise moving an event to a different wallet would strand a
  stale reversed point).
- **Update**: soft-delete this event's linked points up front, then reverse +
  re-apply — `apply` re-creates fresh points for the *new* asset set, so an
  asset-set change leaves no orphans.
- **Delete**: reverse balances, then
  `assetsService.removeValuationsForEvent(eventId)` soft-deletes the event's
  linked points so they disappear from history.

### Editing an `asset_update` revaluation edits its DIFF, not an absolute value

A revaluation record's `amount` **is the signed diff** it represented (e.g. a
wallet revalued 5tr → 4,5tr stores `amount = −0,5tr`). Editing such a record
edits **that diff**, and the edit must **adjust** the asset — never **overwrite**
it with an absolute value (the old behaviour). `MoneyEventsService.updateMoneyEvent`
(the `asset_update` branch) → `AssetsService.applyRevaluationDeltaEdit`:

1. **Shift the running balance by how much the diff moved**:
   `manualValue += (newDelta − oldDelta)`. So a wallet now at 6,5tr (a +2tr inflow
   landed after the revaluation) whose −0,5tr diff is re-entered as −1tr drops to
   6tr, and every later inflow/outflow that stacked on top stays intact — the
   balance re-bases automatically instead of being clobbered. Manual assets hold
   the balance in `manualValue`; market/formula assets have no free balance to
   shift, so only their point is re-stamped and the derived `current_value` is left
   to the price/formula.
2. **Re-stamp this record's own history point at the value it produced *at its
   date*** — `valueBeforeEvent + newDelta` (4tr in the example), NOT the current
   "now" balance. `valueBeforeEvent` (5tr) is recovered as
   `runningBalance − oldDelta − Σ(signed contributions of events dated strictly
   after this record)` (`sumEventContributionsAfter`) — netting out this record's
   own diff plus everything that landed after it. `asset_update` events contribute
   their **signed** delta (not magnitude); normal events contribute `amount − fee`,
   `+` when crediting the asset, `−` when debiting; same-date events are treated as
   NOT "after" (order-ambiguous).

The point is written with an **explicit** value via `writeLinkedValuationPoint`
(same `(moneyEventId, assetId)` upsert as `upsertCurrentValuation`) rather than the
recomputed now-value.

**Frontend** (`use-events-page.ts` + `actual-record-form.tsx`): the revaluation
edit modal now shows **"Mức thay đổi"** (the diff) prefilled from the record's
stored `amount` — magnitude in the money field, sign as a **Tăng / Giảm** toggle
(`revaluationDirection`) — NOT the asset's current balance. Submit sends
`amount = magnitude × (increase ? +1 : −1)` (a signed diff, may be negative;
`UpdateMoneyEventDto.amount` is unvalidated so negatives pass). See [[money-events]].

## Value history over time (asset detail page)

`AssetsService.getAssetValueHistory(householdId, assetId)` reads the persisted
series straight from `asset_value_history` (`findAssetValueHistoryByAsset`),
collapsing duplicate dates (keep last), oldest → newest.

**Fallback** for an asset created before the series existed (no persisted
points): reconstruct from money events (`findMoneyEventsByAsset` — those where
`fromAssetId` **or** `toAssetId` = the asset), as before:
- **market_priced** (`buildMarketValueHistory`) — price the **position**:
  `quantity × current unit price`; a sale = `+soldQuantity` going back; quantity
  0 → single flat point.
- **manual / formula** (`buildCashValueHistory`) — unwind each event's signed
  cash contribution (in `toAsset` +, out `fromAsset` −), floored at 0.

Returns `{ currentValue, items: [{ date, value }], total }`, oldest → newest.
Endpoint: `GET /api/households/:householdId/assets/:assetId/value-history`.
Repo methods: `findAssetValueHistory` (by date, the AS_OF point),
`findAssetValueHistoryByAsset` (list), `findAssetValueHistoryByMoneyEvent`,
`insertAssetValueHistory`, `deleteAssetValueHistory`,
`deleteAssetValueHistoryByMoneyEvent`.

## Where it lives in code

- **frontend-web**: `src/features/assets/model/assets.ts` (`valuationModeForType`, `defaultLiquidityForType`, `computeCurrentValue`, `computeMaturityValue`). Market pricing stubbed in `src/features/assets/api/assets.repository.ts` (`latestPrice→null`, `fxToVnd→1`). Asset detail page + value-history chart: `src/features/assets/ui/asset-detail-page.tsx`, `use-asset-detail.ts` (reads the `value-history` endpoint), `asset-value-chart.tsx`.
- **backend**: `src/common/utils/money-space.utils.ts` (`VALUATION_MODE_BY_TYPE`, `computeCurrentValue`, `fxRateToVnd`, `computeLiquidityTotals`); `src/modules/assets/` (`normalizeAsset`, `upsertCurrentValuation`).
- **mobile-app**: to be ported — must mirror the same tables and formulas.

## Enums

- `ValuationMode = manual | market_priced | formula_calculated`
- `AssetLiquidity = usable_now | not_immediately_usable | long_term`
- `AssetClass = gold | crypto | stock | fund | foreign_currency`
- `AssetType` (15 values, listed in the two tables above)

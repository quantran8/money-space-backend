# Market data (prices & FX)

Read-only reference data that feeds the asset valuation engine. Related: [[asset-valuation]], [[assets]].

## Overview

Two reference tables, both currently used as stand-ins for a future pricing/FX API.

- **`MarketPrice`** — per `assetClass / symbol / market / quoteCurrency`, with `source` + payload hash. Feeds `market_priced` valuation.
- **`FxRate`** — `base → quote` rate, timestamped, with `source`. Feeds FX conversion to VND.

## Rules

- Market price matched by `(assetClass, symbol)`, case-insensitive.
- `fxRateToVnd(base)`: VND→VND = 1; otherwise finds a base→VND rate and returns
  its value, or **`null` when the rate is unknown** (currency ≠ VND). Callers
  MUST treat `null` as "value undefined" — `computeCurrentValue` returns `0`
  rather than mis-pricing. (Was previously `?? 1`, which silently priced 1 USD =
  1 VND when a rate was missing — a ~25,000× understatement; fixed.)
- **Latest-per-key lookup**: the valuation reads go through
  `PrismaRepository.findLatestMarketPrices()` / `findLatestFxRates()` —
  `DISTINCT ON (...) ORDER BY ..., <time> DESC`, one row per instrument, served
  by the `*_latest_idx` indexes. This replaced the old "load the whole table +
  JS `.find()`" pattern so it scales as the price history grows. The
  `/market-data/prices` + `/fx-rates` endpoints also use it (they show the
  current rate board, not the full tick history).
- **Currently stubbed**: frontend `latestPrice() → null` and `fxToVnd() → 1` (`assets.repository.ts`). When a real pricing API is wired, this is the integration point (a writer for `market_prices` / `fx_rates`).

## Where it lives in code

- **backend**: `src/modules/market-data/` (`market-data.service.ts`, `entities/{market-price,fx-rate}.entity.ts`, `repositories/prisma-market-data.repository.ts`).
- **frontend-web**: stubs in `src/features/assets/api/assets.repository.ts`.
- **mobile-app**: to be ported.

# Market data (prices & FX)

Read-only reference data that feeds the asset valuation engine. Related: [[asset-valuation]], [[assets]].

## Overview

Two reference tables, both currently used as stand-ins for a future pricing/FX API.

- **`MarketPrice`** — per `assetClass / symbol / market / quoteCurrency`, with `source` + payload hash. Feeds `market_priced` valuation.
- **`FxRate`** — `base → quote` rate, timestamped, with `source`. Feeds FX conversion to VND.

## Rules

- Market price matched by `(assetClass, symbol)`, case-insensitive.
- `fxRateToVnd(base)` finds a base→VND rate and **defaults to 1** if missing.
- **Currently stubbed**: frontend `latestPrice() → null` and `fxToVnd() → 1` (`assets.repository.ts`); backend FX defaults to 1. When a real pricing API is wired, this is the integration point.

## Where it lives in code

- **backend**: `src/modules/market-data/` (`market-data.service.ts`, `entities/{market-price,fx-rate}.entity.ts`, `repositories/prisma-market-data.repository.ts`).
- **frontend-web**: stubs in `src/features/assets/api/assets.repository.ts`.
- **mobile-app**: to be ported.

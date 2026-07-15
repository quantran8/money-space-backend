# Market data (provider + TTL cache)

External providers are the source of truth for current market quotes. The app
does **not** persist provider ticks in PostgreSQL.

## Flow

- `PriceProvider.getLatestPrices(requests?: SymbolRequest[])` is the adapter
  boundary for a real batched quote provider. It is **told which symbols to
  price** — the distinct `(assetClass, symbol)` universe held across every
  household — so the adapter can batch them into one upstream call.
- `NoopPriceProvider` returns `[]`; it is the fallback when no provider key is set.
- **`TwelveDataPriceProvider`** (https://twelvedata.com) is the real adapter.
  Selected in `MarketDataModule` via a `useFactory` when `TWELVEDATA_API_KEY` is
  set, else the noop provider. Env: `TWELVEDATA_API_KEY` (required to activate),
  `TWELVEDATA_BASE_URL` (optional, default `https://api.twelvedata.com`),
  `MARKET_PRICE_CACHE_TTL_MS` (cache TTL, default 5 min).
  - Prices **stock, fund** (as equities/ETFs) and **crypto** (as `SYMBOL/USD`
    pairs, e.g. `BTC/USD`). **Gold & foreign_currency stay on their existing
    sources** — the adapter ignores those classes.
  - Provider ticker = `priceSourceSymbol ?? symbol`
    (`asset_market_positions.price_source_symbol` is the explicit override). A
    crypto symbol already containing `/` is left as-is.
  - Batches the whole distinct universe into one `GET /price?symbol=A,B,C`. The
    keyed batch response and the un-keyed single-symbol response are both
    normalised. Quotes map back to the **position's own symbol** (not the
    provider ticker) so `quoteFor(assetClass, symbol)` still matches.
  - **Never throws for a partial failure**: a per-symbol error is skipped, a
    top-level/network/HTTP error returns `[]` (and `getMarketPrices` then keeps
    its previous non-empty cache). No key → behaves like noop.
- `MarketDataService.getMarketPrices()` first reads the symbol universe
  (`MarketDataRepository.getMarketSymbolUniverse()` — distinct
  `stock|fund|crypto` positions from `asset_market_positions`), passes it to the
  provider, caches results in process for `MARKET_PRICE_CACHE_TTL_MS` (default 5
  min) and coalesces concurrent refreshes. A stale non-empty cache is returned
  when the provider fails.
- Assets, dashboard and snapshots consume quotes through `MarketDataService`.
- `fx_rates` remains persisted for now; it is a separate concern.

## Daily dashboard-triggered refresh (once per day per household)

When a household opens the dashboard, `DashboardService.getDashboard()`
**fire-and-forgets** `AssetsService.refreshMarketValuationsIfStale(householdId)`
(not awaited — the dashboard returns today's cached values immediately; refreshed
prices land for the next load). That method:
- Skips if a concurrent refresh for the same household is already in flight
  (in-process `refreshInFlight` guard — dedupes two tabs loading at once).
- Skips if the household already has a `market_price_api` valuation point dated
  today (`AssetsRepository.hasMarketValuationOnDate`) — so a household is
  re-priced **at most once per day**.
- Otherwise runs the existing `refreshMarketValuations` (force-refreshes the
  provider cache, then upserts one value-history point per active market asset +
  updates `current_value` + today's snapshot).
- **Never throws** — errors are logged; the dashboard is unaffected.

The existing `POST …/assets/refresh-valuations` endpoint remains the explicit
external-worker entry point for the same refresh.

## Symbol picker (asset-create search + default list)

The asset-create flow needs to pick a stock/crypto symbol. Reference data (which
instruments exist) is a separate concern from quotes (their price):

- `SymbolReferenceProvider.listSymbols(assetClass)` is the reference boundary
  (distinct from `PriceProvider`). `TwelveDataSymbolReferenceProvider` fetches
  the full `/stocks` and `/cryptocurrencies` lists once and caches them **in
  process for 24h** — these are large, near-static lists, so the app pulls each
  once and serves everything from memory. Crypto pairs (`BTC/USD`) are reduced
  to the base ticker (`BTC`), deduped. No API key → `NoopSymbolReferenceProvider`
  returns `[]`. Both are key-gated in `MarketDataModule` via `useFactory`, same
  as the price provider.
- `MarketDataService.searchSymbols({ assetClass, q, limit })`:
  - `assetClass` must be `stock` or `crypto` (else empty result).
  - **No `q`** → the **curated default list** (`DEFAULT_SYMBOLS`, e.g. AAPL/MSFT/
    NVDA…, BTC/ETH/SOL…), each entry upgraded with live reference details
    (name/exchange) when available so it stays accurate.
  - **With `q`** → ranked matches over the reference list: exact ticker > ticker
    prefix > ticker substring > name substring, alphabetical within a tier,
    capped at `limit` (default 20, max 50).
  - **Fallback**: if reference data is unavailable (no key / upstream down) the
    curated list still serves defaults, and a typed query filters that curated
    list — the picker always works.
- Endpoint: `GET /api/market-data/symbols?assetClass=stock|crypto&q=&limit=`
  (auth-gated by the global `SupabaseAuthGuard`; no `:householdId`, so no
  household guard). Returns `{ assetClass, query, items: SymbolReference[], total }`.
  `SymbolReference = { assetClass, symbol, name, exchange, currency, unit }`.
- Code: `src/modules/market-data/providers/{symbol-reference-provider.interface,
  twelve-data-symbol-reference.provider,noop-symbol-reference.provider,
  default-symbols}.ts`, `entities/symbol-reference.entity.ts`,
  `dto/search-symbols.query.ts`, `market-data.service.ts` (`searchSymbols`),
  `market-data.controller.ts`.

## Durable history

The durable record is the user's value, not every provider tick.
`asset_value_history` stores the final value used by the user's chart, without
copying the current position or provider quote into every history row. Current
quantity, average purchase price and latest manually entered price remain in
`asset_market_positions`.

`POST /api/households/:householdId/assets/refresh-valuations` is the idempotent
daily/external-worker entry point. It refreshes provider cache once, then upserts
one value-history point per active market asset for the day and updates
`assets.current_value` plus today's household snapshot.

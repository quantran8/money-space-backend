# Market data (provider + TTL cache)

External providers are the source of truth for current market quotes. The app
does **not** persist provider ticks in PostgreSQL.

## Flow

- `PriceProvider.getLatestPrices(requests?: SymbolRequest[])` is the adapter
  boundary for a real batched quote provider. It is **told which symbols to
  price** — the distinct `(assetClass, symbol)` universe held across every
  household — so the adapter can batch them into one upstream call.
  - `getMarketSymbolUniverse` requires the position to be live **and its asset
    to be live**. Assets are soft-deleted, so the position outlives the asset;
    without the second filter a deleted holding's ticker stayed in the universe
    forever, and the provider was billed on every refresh to price something no
    household still holds. See [[assets]].
- `NoopPriceProvider` returns `[]`; it is the fallback when no provider key is set.
- **Provider routing is per asset class.** `MarketDataModule`'s `useFactory`
  builds a class→adapter map (`providers/provider-routing.ts`) and wraps it in
  **`CompositePriceProvider`**, which splits the universe by class, calls each
  delegate **once** with only its own slice (so per-adapter batching is kept)
  and merges the quotes. Callers still see a single `PriceProvider`, so changing
  which upstream serves a class is a one-line change in `provider-routing.ts`.
  - Routing today: **crypto → CoinMarketCap** when `COIN_MARKETCAP_API_KEY` is
    set, **stock/fund (and crypto as fallback) → Twelve Data** when
    `TWELVEDATA_API_KEY` is set. CMC is applied last so it wins the crypto slot.
  - **Per-position overrides** are checked *before* the class map, because
    `stock` is not served by one upstream: a **Vietnamese** listing goes to
    vnstock, a foreign one to Twelve Data. `isVietnameseEquity` decides from the
    position's venue (`asset_market_positions.market` ∈ HOSE/HSX/HNX/UPCOM) and,
    when no venue is recorded, from it being quoted in **VND**. The **symbol is
    deliberately never used** — a bare code like `FPT` is a plausible foreign
    ticker too, so guessing from the string would misroute.
  - A class whose provider has **no key is left unrouted** → no quotes for it,
    rather than calling an upstream with no credentials. With no key at all the
    factory returns the noop provider.
  - A delegate that throws is logged and contributes nothing — one failing
    upstream must never blank out the classes another priced successfully.
- **`TwelveDataPriceProvider`** (https://twelvedata.com) is the equities adapter.
  Env: `TWELVEDATA_API_KEY` (required to activate),
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
- **`CoinMarketCapPriceProvider`** (https://coinmarketcap.com/api) is the
  **crypto** adapter and the default crypto source. Env:
  `COIN_MARKETCAP_API_KEY` (required to activate), `COIN_MARKETCAP_BASE_URL`
  (optional, default `https://pro-api.coinmarketcap.com`).
  - **Crypto only** — every other class is ignored, so equities stay on their
    own provider.
  - The API key travels as the `X-CMC_PRO_API_KEY` **header**, never in the
    query string.
  - Provider ticker = `priceSourceSymbol ?? symbol`, reduced to the **base**
    ticker (`BTC/USD` → `BTC`): CMC takes the coin and the fiat separately,
    unlike Twelve Data's pair format.
  - **One call per convert-currency**: CMC converts a whole symbol batch into a
    single fiat at a time, so requests are grouped by `quoteCurrency` and each
    group is one `GET /v2/cryptocurrency/quotes/latest?symbol=A,B&convert=CCY`.
    A failing currency yields no quotes for that group while the others resolve.
  - v2 keys each symbol to an **array** of same-ticker coins (tickers are not
    unique upstream, e.g. several coins ticker as `UNI`); CMC ranks by market
    cap, so the **first entry is taken** as canonical. A v1-style bare object is
    also accepted.
  - Quotes map back to the **position's own symbol**, not the sent ticker.
  - **Never throws for a partial failure**: a missing symbol is skipped, a
    top-level/network/HTTP error returns `[]`. No key → behaves like noop.
- **`VnstockPriceProvider`** (`vnstock-js`,
  https://vnstock-js-docs.vercel.app) is the **Vietnamese equity** adapter.
  **Needs no API key**, so unlike every other adapter it is always active; it is
  scoped to VN positions by the routing override rather than by a key gate.
  - **⚠️ vnstock quotes in THOUSANDS of VND** — VNM comes back as `63.8` for a
    63,800₫ share, so quotes are multiplied by **1000** before publishing.
    Verified against the same payload's `totalValue / totalVolume` (0.0638) and
    against `averagePrice` (63.76), both confirming the 1000x scale. Publishing
    the raw number would understate every VN holding by 1000x.
  - Batches the whole VN slice into one `stock.trading.priceBoard([...])` call.
  - Falls back to `referencePrice` when a ticker has not traded yet (pre-open,
    or an illiquid UPCOM name) so the position still values at its official
    reference instead of vanishing from the board.
  - Emits `quoteCurrency: 'VND'` always, and **ignores a position quoted in
    anything else** — a VN share is not quoted in another currency, so handing
    back a VND figure labelled USD would silently misstate the holding.
  - **Never throws**: a missing ticker is skipped, any call failure returns `[]`.
- `MarketDataService.getMarketPrices()` first reads the symbol universe
  (`MarketDataRepository.getMarketSymbolUniverse()` — distinct
  `(assetClass, symbol, market)` positions from `asset_market_positions`), then
  passes it to the provider **through two cache layers** (see below). A stale
  non-empty cache is returned when the provider fails.
- Assets, dashboard and snapshots consume quotes through `MarketDataService`.
- `fx_rates` remains persisted for now; it is a separate concern.

## Caching (two layers)

Provider calls are metered (CMC/Twelve Data credits) and slow, so quotes and
reference lists are cached twice. Both layers **fail open**: with Redis unset or
down, everything still works, just with more upstream calls.

- **Layer 1 — in process** (`MarketDataService.pricesExpireAt`). No I/O at all
  on a hit, and concurrent refreshes within one instance coalesce onto a single
  in-flight promise.
- **Layer 2 — Redis** (`CacheService.wrap`), shared **across instances and
  restarts**, so a cold instance does not re-hit the providers and every
  instance quotes the same figure.

**Every read endpoint on `MarketDataController` is cache-backed** — there is no
uncached market-data endpoint, and `market-data.controller.spec.ts` asserts it
so a newly added endpoint that forgets to cache fails the build. Market data is
global, comes from metered or rate-limited upstreams, and is identical for every
household, so an uncached endpoint means a provider call (or a Postgres query)
per request.

Keys live in `cache.keys.ts` like everything else, but deliberately **NOT under
the `hh:<id>:` prefix**:

| Key | TTL | Serves |
| --- | --- | --- |
| `market:prices` | 5 min (`MARKET_PRICE_CACHE_TTL_MS`) | `GET /prices` |
| `market:symbols:<assetClass>` | 24h | `GET /symbols` |
| `market:gold` | 5 min | `GET /gold-prices` |
| `market:fx-counter` | 5 min | `GET /fx-counter-rates` |
| `market:fx-rates` | 15 min | `GET /fx-rates` |

The symbol adapters keep their own 24h in-process cache underneath, so a Redis
miss is still cheap. `market:fx-rates` is the one key fronting **Postgres**
rather than a provider — it is written by the daily refresh, not intraday, so
re-querying per request buys nothing.

**Why not under `hh:`**: market data is global and identical for every
household. Under that prefix, the `CacheInvalidationInterceptor` would drop it
after *any* household write — a household editing an asset has not changed what
BTC is worth, and that would mean a provider round-trip per write.

Two rules the tests pin down:

- **An empty result is never cached.** Neither an empty quote list nor an empty
  reference list may evict or replace a good entry — an empty response means
  "upstream unavailable" (rate limit, all tickers unknown), and memoising it
  would pin the app to no prices / curated defaults long after recovery.
- **`forceRefresh` bypasses both layers and rewrites them**, so the daily
  valuation refresh genuinely re-prices instead of re-reading the entry it is
  about to replace.

## On-demand quote (`GET /quote`) — the asset-create flow

`GET /api/market-data/quote?assetClass=&symbol=&market=` prices **one**
instrument and returns `{ quote: MarketPrice | null }`.

- **Why it exists**: `GET /prices` only covers the universe of positions
  households already hold (`getMarketSymbolUniverse`). A symbol the user is
  adding for the first time is by definition not in that set, so it would come
  back empty — the create form needs a lookup by symbol.
- Routing follows the same map as the batch path, with two additions:
  - `gold` and `foreign_currency` are priced from the **commodity feed**
    (`commodityQuote`), not the instrument providers — they have no ticker.
    Both use the **sell** side (what the household pays to acquire), gold
    falling back to the buy side when the dealer does not sell that product.
  - The default `quoteCurrency` is **VND** for gold, foreign currency and VN
    equities; **USD** otherwise. Asking a provider for a currency it cannot
    convert to would return nothing.
- Returns `null` — never an error — when the symbol cannot be priced, so the
  client degrades to a user-typed price rather than blocking asset creation.
- Cached at `market:quote:<class>:<symbol>:<market>:<currency>` for the same
  5 minutes as the batch quotes.

## Daily capture of market asset values

Two paths write the same daily point, both funnelling into
`AssetsService.refreshMarketValuations`. The durable record is one
`asset_valuations` row per market asset per day, carrying the **total value**
(`quantity × price × FX`) — not the per-unit price, which stays in
`asset_market_positions`.

### The split: history is settled, today is live

- **`asset_valuations` holds closed days only.** A point is written once, at the
  end of the day, from that day's final prices.
- **Today is never in history** while prices are still moving. It is the live
  figure — `assets.current_value`, and the `currentValue` the value-history
  endpoint returns alongside `items`. Consumers already read both, so a chart
  draws settled history plus today's live point without any extra call.

This is why the dashboard refresh no longer writes a point: an unsettled
intraday figure sitting in a series of end-of-day values is not comparable with
the rest of it.

### The scheduled job (`AssetsValuationCron`)

`@Cron('45 23 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })` — **23:45 Vietnam
time**.

**Why the end of the day and not the morning or the market close.** A portfolio
mixes markets that close at different times, and one that never closes:
- HOSE trades **09:00–14:45** (ATC 14:30) — read from vnstock's trading calendar.
- **Crypto trades 24/7**; its day only ends at midnight.
- Gold dealers republish through the day (observed as late as ~16:00).

A morning run reads the *previous* session's close and stamps it with today —
every point a day out. A run at the HOSE close is right for equities but freezes
crypto at 14:45 and misses the rest of its day. 23:45 is a true end-of-day
figure for every class at once, while still being the same calendar day, so the
point carries the date it actually priced.

**Multi-instance: a Postgres advisory lock.** Every instance fires the
schedule, so the run is wrapped in `withAdvisoryLock` — one instance does the
work, the rest return immediately. Verified with two real app contexts racing:
one priced 2 households, the other skipped.

Postgres rather than Redis, even though Redis is available:
- `CacheService` is deliberately **fail-open** — a Redis outage reports a miss,
  which for a lock means *everyone* runs: exactly the failure the lock prevents.
  Postgres is already a hard dependency of this job, so there is no new one.
- A **session** advisory lock is released automatically when the connection
  drops, so an instance crashing mid-run cannot deadlock the next day. Verified
  against the live pooler: disconnecting without `pg_advisory_unlock` frees it.

The lock is an optimisation, not a correctness requirement: the work list is
"households with no point for today" and the write is an upsert, so a duplicate
run converges on the same result. `MARKET_VALUATION_CRON_ENABLED=false` still
disables the job on an instance entirely.

**The date is resolved once**, at the start of the run, and passed to every
household: the job fires at 23:45, a long batch can cross midnight, and
re-reading "today" per household would split one run across two dates.

- **Why it exists**: the dashboard path below only fires for households someone
  actually opens. A household nobody visits for a week has no points for that
  week, and the value chart draws a straight line across it — the price movement
  in between simply disappears.
- **Work list is one SQL query** (`findHouseholdsNeedingMarketValuation`):
  households with an active market-priced asset and **no** `market_price_api`
  point for today. The "already done" check is inside the query — done per
  household it would be one round-trip each.
- **Concurrency is capped** (`MARKET_VALUATION_CONCURRENCY`, default **3**).
  `DATABASE_URL` carries `connection_limit=8` against a project-wide
  `pool_size: 15`, and each refresh holds a connection for its transaction. Run
  wide open, the job would drain the pool and starve live requests — it must
  never make the app slower for someone using it.
- **Bounded per tick** (`MARKET_VALUATION_BATCH_LIMIT`, default 500). Leftovers
  resume next run, since the work list is "not yet priced today".
- One household failing is logged and **does not abandon the batch**; an
  overlapping tick is skipped (`running` guard) so pool pressure cannot double.
- **Multi-instance**: every instance schedules this. Safe but wasteful — the
  first writer wins and the rest find an empty work list. Set
  `MARKET_VALUATION_CRON_ENABLED=false` on all but one instance, or drive
  `POST /assets/refresh-valuations` from an external scheduler instead.

### The single writer

`AssetsValuationCron` is now the **only** thing that writes the daily series.

The dashboard used to fire a background re-price on every visit
(`refreshMarketValuationsIfStale`). That has been removed, along with the method
and `DashboardService`'s dependency on `AssetsService`:

- It was **never needed for correctness**. `buildDashboard` recomputes every
  asset's `currentValue` live via `computeCurrentValue(asset, marketPrices, …)`
  on each build, so the figures on screen never came from the background write.
  Verified by forcing `assets.current_value` to 1 and confirming the dashboard
  still reported the real number.
- Once the cron guaranteed the daily point, the visit-triggered write only added
  load — and wrote an unsettled intraday figure into a series of end-of-day
  values.

`POST …/assets/refresh-valuations` remains as the manual / external-worker entry
point for the same refresh.

### Writes are batched, not per-asset

`refreshMarketValuations` computes every value first (pure arithmetic over data
already in memory), then writes the batch in **two statements**:
`upsertMarketValuationPoints` (one `INSERT … ON CONFLICT`) and
`updateAssetCurrentValues` (one `UPDATE … FROM (VALUES …)`).

The old per-asset path cost **three round-trips each** (lookup, write, current
value). At the measured ~53ms RTT that is ~1.6s for ten positions, and a
household with ~30 would blow the interactive-transaction timeout (Prisma's
default 5s) and roll the **whole day back**, losing the data point entirely.
Multiplied across every household by the cron it would also monopolise the
connection pool. Batching makes the per-household cost flat.

The upsert's conflict target is the partial unique index
`asset_valuations_asset_date_cache_unique (asset_id, valuation_date)
WHERE money_event_id IS NULL AND deleted_at IS NULL` — i.e. only the unlinked
"value on this date" row. **Event-linked points are never touched**, so a money
event's own valuation cannot be clobbered by a re-price.

## Gold prices & bank FX counter rates

Two live endpoints for figures a Vietnamese household actually transacts at,
both from `vnstock-js` via `CommodityProvider` (`COMMODITY_PROVIDER`) — a
boundary kept **separate from `PriceProvider`** because the shape genuinely
differs: these are dealer/bank quotes with a **buy/sell spread**, not one mid
price for a position the household holds a quantity of. `VnstockCommodityProvider`
is the adapter (no API key); `NoopCommodityProvider` is the documented fallback.

- **`GET /api/market-data/gold-prices?brand=SJC`** → `{ items: GoldPrice[], total }`.
  Prices are **VND per lượng**, plain numbers (upstream sends strings).
  - The feed **repeats each product at several publish times** the same day
    (e.g. 16:17 and 09:00). Only the **most recent row per product** is kept —
    otherwise one list would silently mix a price history together. Measured
    live: 20 raw rows → **10** products.
  - `sellPrice: 0` upstream means **the dealer does not sell that product**, so
    it is surfaced as **`null`**, never `0` — a zero would read as free. Same
    rule for `buyCash`/`buyTransfer`/`sell` on FX. A row with no side priced is
    dropped entirely.
  - Names arrive as `"NHẪN TRÒN TRƠN (Vàng Rồng Thăng Long)"` and are split into
    `name` + `brand` so clients can group by dealer without parsing strings.
  - Upstream stamps are Vietnamese `DD/MM/YYYY HH:mm` in **UTC+7**, which
    `new Date(...)` cannot parse (it yields `Invalid Date`, or reads it as
    MM/DD). Parsed explicitly and anchored to UTC+7.
  - **`commodity.gold.price()` is used with its default `auto` source** — the
    package's SJC endpoint is deprecated and 403s from non-Vietnam IPs, so no
    source is pinned.

- **`GET /api/market-data/fx-counter-rates?currencyCode=USD`** →
  `{ items: FxCounterRate[], total }`: the bank's three-way spread
  (`buyCash` / `buyTransfer` / `sell`) against VND.
  - **All legs are VND per ONE unit** of the currency. Verified against
    cross-rates — implied USD/JPY 155.2 and USD/KRW 1339 both match reality — so
    the **per-100 convention** some Vietnamese banks publish for JPY/KRW does
    **not** apply to this feed and must not be "corrected" for.
  - ~8 currencies (DKK, INR, KWD, MYR, NOK, RUB, SAR, SEK) are transfer-only;
    their cash leg comes back `null`.
  - **Distinct from `GET /fx-rates`**, which serves the single *persisted*
    reference rate from the `fx_rates` table. Both endpoints exist on purpose:
    one is the stored reference figure, the other is what a bank quotes today.

Neither method ever throws, and neither can hold a request for long:

- **Hard timeout** (`COMMODITY_TIMEOUT_MS`, default 4s). `vnstock` retries
  internally — 3 attempts x 15s — so a slow dealer feed held
  `GET /symbols?assetClass=gold` for **~48s in production**. The provider caps
  the call itself rather than inheriting that retry budget.
- **Stale beats empty.** On timeout or failure the last good list is served.
  Returning `[]` made `getQuote` find no matching product and answer `null` —
  the second production symptom, on the same root cause.
- **Concurrent callers coalesce** onto one upstream call, and the lists are
  **prewarmed at boot** (`onModuleInit`) so the first real request never pays
  for a cold fetch.

- Code: `src/modules/market-data/providers/{commodity-provider.interface,
  vnstock-commodity.provider,noop-commodity.provider}.ts`,
  `entities/{gold-price,fx-rate}.entity.ts`,
  `dto/{list-gold-prices,list-fx-counter-rates}.query.ts`.

## Symbol picker (asset-create search + default list)

The asset-create flow needs to pick a stock/crypto symbol. Reference data (which
instruments exist) is a separate concern from quotes (their price):

- `SymbolReferenceProvider.listSymbols(assetClass)` is the reference boundary
  (distinct from `PriceProvider`). Reference routing **mirrors price routing**
  so the pair stays in step, but a class may have **several** sources:
  `CompositeSymbolReferenceProvider` concatenates them **in route order** and
  de-dupes by symbol, first source winning — so order encodes precedence.
  - `stock` → **[vnstock, Twelve Data]**: Vietnamese listings lead the picker in
    this Vietnamese-first app, and vnstock needs no key so the list is never
    empty. `crypto` → CoinMarketCap, falling back to Twelve Data.
  - A delegate that throws is logged and contributes nothing; the remaining
    sources still produce a list, and if all fail the service falls back to the
    curated defaults instead of erroring.
- `VnstockCommoditySymbolReferenceProvider` lists **gold/silver** and
  **foreign currency** — the two market-priced classes with no upstream
  instrument database. Both are derived from the live commodity feed rather
  than hard-coded, so every listed item is one the price feed can quote.
  - **Gold is an allowlist** (`GOLD_PRODUCTS`) resolved against the feed: the
    feed also carries one-off gift items and jewellery lines that would bury the
    products people hold. A listed product the dealer is not publishing today is
    skipped rather than offered unpriceable.
  - **Silver is taken whole from the feed** (matched by `BẠC`), and shares the
    `gold` asset class — the app has one precious-metal class, and both are
    held, priced and sold the same way. Measured live: 4 gold + 11 silver = 15.
  - **Currencies** are a short supported list (USD, JPY) intersected with the
    bank counter-rate feed; a currency the bank is not quoting is not offered.

### Gold feed integrity (BTMC truncation)

The BTMC feed is plain **HTTP on port 80** and its ~17KB body can be cut off
mid-stream on the way out of the region. Axios then resolves with whatever
arrived, so a truncated response looks like a success — it does not throw, and
`vnstock-js`'s own `auto` fallback never fires.

Observed on prod (OCI Singapore, 2026-08-23): the symbol endpoint returned only
the first 3 gold products and no silver at all, while the quote for
`VÀNG MIẾNG SJC` returned `null`. Replaying the parser against a payload cut at
6 of 92 rows reproduces that response exactly. Local (Vietnam) gets all 92 rows
in ~130ms.

Guards in `VnstockCommodityProvider`:

- **A short body is rejected, not cached.** Under `MIN_GOLD_ROWS` (20; a healthy
  payload is ~92) the round is treated as truncated and retried once. A partial
  list is worse than a stale one — it silently drops products people hold, so
  both the picker and the quote go missing for an asset that exists.
- **BTMC was dropped entirely on 2026-08-27; giavang.net is the only gold
  feed.** BTMC is plain **HTTP on port 80**: from OCI Singapore its ~17KB body
  arrived truncated or not at all, and it contributed **zero products in
  production** while answering fine (373 rows / 135ms) from Vietnam. Keeping a
  feed that only works from one country is what produced the 10s `/quote` and
  the 3-item picker. giavang.net is **HTTPS** and answers in ~200ms.
  Measured after the removal: **11 products in 157ms**.
  - **Every retail row is its own product** (11 of 14 rows; the two index codes
    and any stale row are dropped). Collapsing dealers onto three shared names
    served **3 items** where the feed carried 11 — and the per-dealer spread is
    the point of the feed: DOJI's nhẫn quotes 152.9M against SJC's 150.0M.
  - `VÀNG MIẾNG SJC`, `NHẪN TRÒN TRƠN` and `VÀNG MIẾNG VRTL` **keep their BTMC
    names** so stored assets still resolve; the rest are named per dealer
    (`VÀNG MIẾNG DOJI HCM`, `NHẪN TRÒN TRƠN PHÚ QUÝ`) and listed in
    `GOLD_PRODUCTS`.
  - **⚠️ Silver has no source any more.** BTMC was the only feed carrying it, so
    the picker lost **11 silver products** (`BẠC THỎI ANCARAT`, `BẠC MIẾNG PHÚ
    QUÝ`, `BẠC … RỒNG THĂNG LONG`). A household still holding one keeps the
    asset, but it **cannot be re-priced and no longer appears in the picker**.
    `SILVER_MARKER` is deliberately left in place so silver returns
    automatically if a feed ever supplies it.
- **giavang.net rows are remapped.** That feed keys rows by `type_code` and
  sends `type: "GOLD"` for every row, which vnstock's transform maps onto
  `name` — so an unmapped fallback collapses to a single product called `GOLD`
  matching nothing in `GOLD_PRODUCTS`. `GIAVANGNET_PRODUCTS` maps each code onto
  the BTMC product name it quotes (verified by matching quoted prices), keeping
  symbols stable across sources so stored assets keep resolving. Index codes
  (`XAUUSD`, `USDX`) are excluded — not retail products.
- **`updatedAt` arrives as `YYYY-MM-DD`, not unix seconds.** The parser assumed
  seconds, so `Number("2026-08-27")` was `NaN` and **every row fell back to
  "now"**. Both shapes are now parsed, dates anchored to UTC+7, and an
  unparseable stamp returns `null` rather than today.
- **A row the feed has stopped updating is dropped**
  (`COMMODITY_MAX_ROW_AGE_DAYS`, default 7). giavang.net still ships delisted
  products at their last-ever price — `VNGN` at its **2025-05-07** figure,
  `USDX` at 2026-02-01 — which the "now" fallback published as today's price.
- **`COMMODITY_TIMEOUT_MS` defaults to 10s** (was 4s): a cross-border round trip
  to a Vietnamese feed needs the headroom that a local run never shows.

Both the gold quote and the gold list read through the **same Redis key**
(`market:gold`); the quote path formerly called the provider directly, letting
the two disagree about which products exist.
- `VnstockSymbolReferenceProvider` lists **VN equities** and needs no network
  call per lookup: `stock.search` is a *synchronous* query over a directory
  bundled with the package, which `init()` loads once (the promise is reused so
  concurrent callers don't re-load it). Its 24h cache exists to avoid
  re-filtering ~3.3k rows per keystroke, not to save API credits.
  - **Only tradable HSX/HNX/UPCOM equities are listed.** The raw directory also
    carries ~1.4k `DELISTED` rows and ~85 `BOND` rows; offering those in the
    picker would let someone hold a position nothing can ever price. Measured
    live: 3,315 raw → **1,857** listed.
  - **Covered warrants are excluded by name** (`chứng quyền` / `covered
    warrant`), not by exchange: an active warrant like `CVNM2511` trades on HSX
    exactly like a share, so the exchange filter alone let them through — and
    searching "VNM" then returned four warrants ahead of VNM itself. They are
    short-dated derivatives that expire worthless, not a household holding.
  - Vietnamese `companyName` is preferred over `companyNameEn`; `currency` is
    `VND` and `unit` is `cp`.
- `TwelveDataSymbolReferenceProvider` fetches the full `/stocks` and
  `/cryptocurrencies` lists; `CoinMarketCapSymbolReferenceProvider` fetches
  `/v1/cryptocurrency/map` (`listing_status=active`, `sort=cmc_rank`,
  `limit=5000`) and is **crypto-only** (`listSymbols('stock')` → `[]`). Both
  cache **in process for 24h** — large, near-static lists, so the app pulls each
  once and serves search/defaults from memory rather than spending call credits
  per keystroke. Concurrent callers coalesce onto one in-flight request, and a
  **failed refresh keeps the previous list** rather than caching an empty one.
  - Twelve Data crypto pairs (`BTC/USD`) are reduced to the base ticker (`BTC`),
    deduped. CMC tickers are **not unique**, so rank order means the first row
    for a symbol (the highest-ranked coin) wins the de-dupe.
  - No API key → `NoopSymbolReferenceProvider` returns `[]`. All key-gated in
    `MarketDataModule` via `useFactory`, same as the price provider.
- `MarketDataService.searchSymbols({ assetClass, q, limit })`:
  - `assetClass` must be `stock` or `crypto` (else empty result).
  - **Gold and foreign currency return their WHOLE list** with no `q`, not a
    curated shortlist — those lists are already short and curated upstream (the
    dealer's products, the supported currencies), so filtering them through
    `DEFAULT_SYMBOLS` would hide most of what the user can actually pick.
  - **No `q`** (stock/crypto) → the **curated default list** (`DEFAULT_SYMBOLS`, e.g. AAPL/MSFT/
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
  twelve-data-symbol-reference.provider,coinmarketcap-symbol-reference.provider,
  vnstock-symbol-reference.provider,composite-symbol-reference.provider,
  noop-symbol-reference.provider,provider-routing,default-symbols}.ts`,
  `entities/symbol-reference.entity.ts`,
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

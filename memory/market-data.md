# Market data (provider + TTL cache)

External providers are the source of truth for current market quotes. The app
does **not** persist provider ticks in PostgreSQL.

## Flow

- `PriceProvider` is the adapter boundary for a real batched quote provider.
- `NoopPriceProvider` is the default until a provider is configured.
- `MarketDataService.getMarketPrices()` caches provider results in process for
  `MARKET_PRICE_CACHE_TTL_MS` (default 5 minutes) and coalesces concurrent
  refreshes. A stale non-empty cache is returned when the provider fails.
- Assets, dashboard and snapshots consume quotes through `MarketDataService`.
- `fx_rates` remains persisted for now; it is a separate concern.

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

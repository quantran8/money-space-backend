import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { cacheKeys } from '../../common/cache/cache.keys';
import type { CacheService } from '../../common/cache/cache.service';

/**
 * Every read endpoint on this controller must be served through the cache.
 *
 * Market data is global, comes from metered or rate-limited upstreams, and is
 * identical for every household — an uncached endpoint means a provider call
 * (or a Postgres query) per request. This test drives each endpoint through the
 * real service and asserts the cache was consulted, so a newly added endpoint
 * that forgets to cache fails here rather than in production.
 */
describe('MarketDataController caching', () => {
  function build() {
    const keysUsed: string[] = [];
    const store = new Map<string, unknown>();
    const cache = {
      get: jest.fn((key: string) => {
        keysUsed.push(key);
        return Promise.resolve(store.get(key));
      }),
      set: jest.fn((key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      wrap: jest.fn(async (key: string, loader: () => Promise<unknown>) => {
        keysUsed.push(key);
        if (store.has(key)) return store.get(key);
        const value = await loader();
        store.set(key, value);
        return value;
      }),
    } as unknown as CacheService;

    const service = new MarketDataService(
      {
        getFxRates: jest.fn().mockResolvedValue([]),
        getMarketSymbolUniverse: jest.fn().mockResolvedValue([]),
      },
      { getLatestPrices: jest.fn().mockResolvedValue([]) },
      { listSymbols: jest.fn().mockResolvedValue([]) },
      {
        getGoldPrices: jest.fn().mockResolvedValue([]),
        getFxCounterRates: jest.fn().mockResolvedValue([]),
      },
      cache,
    );
    return { controller: new MarketDataController(service), keysUsed };
  }

  it.each([
    [
      'prices',
      cacheKeys.marketPrices(),
      (c: MarketDataController) => c.listMarketPrices({}),
    ],
    [
      'fx-rates',
      cacheKeys.fxRates(),
      (c: MarketDataController) => c.listFxRates({}),
    ],
    [
      'gold-prices',
      cacheKeys.goldPrices(),
      (c: MarketDataController) => c.listGoldPrices({}),
    ],
    [
      'fx-counter-rates',
      cacheKeys.fxCounterRates(),
      (c: MarketDataController) => c.listFxCounterRates({}),
    ],
    [
      'symbols',
      cacheKeys.symbolReference('stock'),
      (c: MarketDataController) => c.searchSymbols({ assetClass: 'stock' }),
    ],
    [
      'quote',
      cacheKeys.quote('stock', 'VNM', 'HOSE', 'VND'),
      (c: MarketDataController) =>
        c.getQuote({ assetClass: 'stock', symbol: 'VNM', market: 'HOSE' }),
    ],
  ])('GET %s reads through the cache', async (_name, key, call) => {
    const { controller, keysUsed } = build();

    await call(controller);

    expect(keysUsed).toContain(key);
  });

  it('keeps every market-data key out of the per-household namespace', () => {
    // Under `hh:`, CacheInvalidationInterceptor would drop these after any
    // household write — but editing an asset does not change the gold price.
    const keys = [
      cacheKeys.marketPrices(),
      cacheKeys.fxRates(),
      cacheKeys.goldPrices(),
      cacheKeys.fxCounterRates(),
      cacheKeys.symbolReference('stock'),
    ];

    for (const key of keys) {
      expect(key.startsWith('hh:')).toBe(false);
      expect(key.startsWith('market:')).toBe(true);
    }
  });
});

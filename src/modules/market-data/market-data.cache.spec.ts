import { MarketDataService } from './market-data.service';
import { cacheKeys, cacheTtl } from '../../common/cache/cache.keys';
import type { CacheService } from '../../common/cache/cache.service';
import type { MarketPrice } from './entities/market-price.entity';
import type { SymbolReference } from './entities/symbol-reference.entity';
import type { GoldPrice } from './entities/gold-price.entity';
import type { FxCounterRate } from './entities/fx-rate.entity';

const QUOTE: MarketPrice = {
  assetClass: 'crypto',
  symbol: 'BTC',
  price: 65_000,
  unit: 'BTC',
  quoteCurrency: 'USD',
  priceTime: '2026-01-01T00:00:00.000Z',
  source: 'coinmarketcap',
};

const VN_STOCK: SymbolReference = {
  assetClass: 'stock',
  symbol: 'VNM',
  name: 'Vinamilk',
  exchange: 'HSX',
  currency: 'VND',
  unit: 'cp',
};

/** An in-memory stand-in for Redis, with the same read-through contract. */
function fakeCache() {
  const store = new Map<string, unknown>();
  const service = {
    store,
    get: jest.fn((key: string) => Promise.resolve(store.get(key))),
    set: jest.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    wrap: jest.fn(async (key: string, loader: () => Promise<unknown>) => {
      if (store.has(key)) return store.get(key);
      const value = await loader();
      store.set(key, value);
      return value;
    }),
  };
  return service as unknown as CacheService & typeof service;
}

/** A cache that is switched off, as when `REDIS_URL` is unset. */
function disabledCache() {
  return {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
    wrap: jest.fn((_key: string, loader: () => Promise<unknown>) => loader()),
  } as unknown as CacheService;
}

function build(
  cache: CacheService,
  overrides: {
    prices?: MarketPrice[];
    reference?: SymbolReference[];
    gold?: GoldPrice[];
    fx?: FxCounterRate[];
  } = {},
) {
  const getLatestPrices = jest
    .fn()
    .mockResolvedValue(overrides.prices ?? [QUOTE]);
  const listSymbols = jest
    .fn()
    .mockResolvedValue(overrides.reference ?? [VN_STOCK]);
  const getMarketSymbolUniverse = jest.fn().mockResolvedValue([]);
  const getGoldPrices = jest.fn().mockResolvedValue(overrides.gold ?? []);
  const getFxCounterRates = jest.fn().mockResolvedValue(overrides.fx ?? []);

  const service = new MarketDataService(
    {
      getFxRates: jest.fn().mockResolvedValue([]),
      getMarketSymbolUniverse,
    },
    { getLatestPrices },
    { listSymbols },
    { getGoldPrices, getFxCounterRates },
    cache,
  );
  return {
    service,
    getLatestPrices,
    listSymbols,
    getMarketSymbolUniverse,
    getGoldPrices,
    getFxCounterRates,
  };
}

describe('MarketDataService price caching', () => {
  it('caches quotes in Redis under a global, non-household key', async () => {
    const cache = fakeCache();
    const { service, getLatestPrices } = build(cache);

    await service.getMarketPrices();

    expect(cache.wrap).toHaveBeenCalledWith(
      cacheKeys.marketPrices(),
      expect.any(Function),
      expect.any(Number),
    );
    // Market data is identical for every household, so it must NOT sit under
    // the `hh:` prefix that per-household invalidation wipes.
    expect(cacheKeys.marketPrices().startsWith('hh:')).toBe(false);
    expect(getLatestPrices).toHaveBeenCalledTimes(1);
  });

  it('serves a second call from the in-process cache without touching Redis', async () => {
    const cache = fakeCache();
    const { service, getLatestPrices } = build(cache);

    await service.getMarketPrices();
    await service.getMarketPrices();

    expect(getLatestPrices).toHaveBeenCalledTimes(1);
    expect(cache.wrap).toHaveBeenCalledTimes(1);
  });

  it('serves a cold instance from Redis without calling the provider', async () => {
    const cache = fakeCache();
    const first = build(cache);
    await first.service.getMarketPrices();

    // A second instance shares the Redis entry — the point of this layer.
    const second = build(cache);
    const result = await second.service.getMarketPrices();

    expect(result).toEqual([QUOTE]);
    expect(second.getLatestPrices).not.toHaveBeenCalled();
  });

  it('coalesces concurrent cold reads into one provider call', async () => {
    const cache = fakeCache();
    const { service, getLatestPrices } = build(cache);

    const [a, b] = await Promise.all([
      service.getMarketPrices(),
      service.getMarketPrices(),
    ]);

    expect(getLatestPrices).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('forceRefresh bypasses both layers and rewrites the entry', async () => {
    const cache = fakeCache();
    const { service, getLatestPrices } = build(cache);
    await service.getMarketPrices();
    expect(getLatestPrices).toHaveBeenCalledTimes(1);

    const refreshed: MarketPrice[] = [{ ...QUOTE, price: 70_000 }];
    getLatestPrices.mockResolvedValue(refreshed);
    const result = await service.getMarketPrices(true);

    expect(getLatestPrices).toHaveBeenCalledTimes(2);
    expect(result).toEqual(refreshed);
    // The refreshed figure is what the next reader sees.
    expect(cache.store.get(cacheKeys.marketPrices())).toEqual(refreshed);
  });

  it('never lets an empty refresh evict quotes it could still serve', async () => {
    const cache = fakeCache();
    const { service, getLatestPrices } = build(cache);
    await service.getMarketPrices();

    // Upstream returns nothing (rate limited, all tickers unknown, …).
    getLatestPrices.mockResolvedValue([]);
    const result = await service.getMarketPrices(true);

    expect(result).toEqual([QUOTE]);
    expect(cache.store.get(cacheKeys.marketPrices())).toEqual([QUOTE]);
  });

  it('still works with the cache disabled', async () => {
    const { service, getLatestPrices } = build(disabledCache());

    const result = await service.getMarketPrices();

    expect(result).toEqual([QUOTE]);
    expect(getLatestPrices).toHaveBeenCalledTimes(1);
  });
});

describe('MarketDataService reference caching', () => {
  it('caches the reference list per asset class with a long TTL', async () => {
    const cache = fakeCache();
    const { service, listSymbols } = build(cache);

    await service.searchSymbols({ assetClass: 'stock', q: 'VNM' });

    expect(cache.set).toHaveBeenCalledWith(
      cacheKeys.symbolReference('stock'),
      [VN_STOCK],
      cacheTtl.symbolReference,
    );
    expect(listSymbols).toHaveBeenCalledTimes(1);
  });

  it('does not re-hit the provider on a second search', async () => {
    const cache = fakeCache();
    const { service, listSymbols } = build(cache);

    await service.searchSymbols({ assetClass: 'stock', q: 'VNM' });
    const again = await service.searchSymbols({ assetClass: 'stock', q: 'VN' });

    expect(listSymbols).toHaveBeenCalledTimes(1);
    expect(again.items.map((i) => i.symbol)).toContain('VNM');
  });

  it('keys crypto and stock separately', async () => {
    const cache = fakeCache();
    const { service } = build(cache);

    await service.searchSymbols({ assetClass: 'stock', q: 'V' });
    await service.searchSymbols({ assetClass: 'crypto', q: 'B' });

    expect([...cache.store.keys()]).toEqual(
      expect.arrayContaining([
        cacheKeys.symbolReference('stock'),
        cacheKeys.symbolReference('crypto'),
      ]),
    );
  });

  it('never caches an empty list, so a recovered provider is picked up', async () => {
    const cache = fakeCache();
    const { service, listSymbols } = build(cache, { reference: [] });

    await service.searchSymbols({ assetClass: 'stock', q: 'VNM' });
    expect(cache.store.has(cacheKeys.symbolReference('stock'))).toBe(false);

    // Provider recovers; the next search must see the real list.
    listSymbols.mockResolvedValue([VN_STOCK]);
    const result = await service.searchSymbols({
      assetClass: 'stock',
      q: 'VNM',
    });

    expect(result.items.map((i) => i.symbol)).toEqual(['VNM']);
  });
});

describe('MarketDataService commodity + fx caching', () => {
  const GOLD: GoldPrice = {
    name: 'VÀNG MIẾNG SJC',
    brand: 'Vàng SJC',
    karat: '24k',
    fineness: '999.9',
    buyPrice: 14_400_000,
    sellPrice: 14_700_000,
    priceTime: '2026-08-21T09:17:00.000Z',
    source: 'btmc',
  };
  const USD: FxCounterRate = {
    currencyCode: 'USD',
    currencyName: 'US DOLLAR',
    buyCash: 25_900,
    buyTransfer: 25_930,
    sell: 26_310,
    source: 'vnstock',
  };

  it('caches gold quotes and does not re-hit the provider', async () => {
    const cache = fakeCache();
    const { service, getGoldPrices } = build(cache, { gold: [GOLD] });

    const first = await service.listGoldPrices();
    await service.listGoldPrices();

    expect(first.items).toEqual([GOLD]);
    expect(getGoldPrices).toHaveBeenCalledTimes(1);
    expect(cache.store.get(cacheKeys.goldPrices())).toEqual([GOLD]);
  });

  it('filters gold by brand without re-fetching', async () => {
    const cache = fakeCache();
    const other: GoldPrice = { ...GOLD, name: 'NHẪN TRÒN', brand: 'BTMC' };
    const { service, getGoldPrices } = build(cache, { gold: [GOLD, other] });

    const result = await service.listGoldPrices({ brand: 'sjc' });

    expect(result.items.map((i) => i.brand)).toEqual(['Vàng SJC']);
    expect(getGoldPrices).toHaveBeenCalledTimes(1);
  });

  it('caches FX counter rates and filters by currency', async () => {
    const cache = fakeCache();
    const jpy: FxCounterRate = { ...USD, currencyCode: 'JPY', sell: 169.55 };
    const { service, getFxCounterRates } = build(cache, { fx: [USD, jpy] });

    const all = await service.listFxCounterRates();
    const filtered = await service.listFxCounterRates({ currencyCode: 'jpy' });

    expect(all.total).toBe(2);
    expect(filtered.items.map((i) => i.currencyCode)).toEqual(['JPY']);
    expect(getFxCounterRates).toHaveBeenCalledTimes(1);
  });

  it('caches the persisted fx-rates list so Postgres is queried once', async () => {
    const cache = fakeCache();
    const rate = {
      baseCurrency: 'USD',
      quoteCurrency: 'VND',
      rate: 26_000,
      asOf: '2026-08-21',
      source: 'seed',
    };
    const getFxRates = jest.fn().mockResolvedValue([rate]);
    const service = new MarketDataService(
      { getFxRates, getMarketSymbolUniverse: jest.fn().mockResolvedValue([]) },
      { getLatestPrices: jest.fn().mockResolvedValue([]) },
      { listSymbols: jest.fn().mockResolvedValue([]) },
      {
        getGoldPrices: jest.fn().mockResolvedValue([]),
        getFxCounterRates: jest.fn().mockResolvedValue([]),
      },
      cache,
    );

    await service.listFxRates({});
    const second = await service.listFxRates({ baseCurrency: 'USD' });

    expect(getFxRates).toHaveBeenCalledTimes(1);
    expect(second.items).toEqual([rate]);
  });

  it('still serves gold and fx with the cache disabled', async () => {
    const { service } = build(disabledCache(), { gold: [GOLD], fx: [USD] });

    expect((await service.listGoldPrices()).items).toEqual([GOLD]);
    expect((await service.listFxCounterRates()).items).toEqual([USD]);
  });
});

describe('MarketDataService.getQuote (asset-create)', () => {
  const VNM_QUOTE = {
    assetClass: 'stock' as const,
    symbol: 'VNM',
    price: 63_800,
    unit: 'VNM',
    quoteCurrency: 'VND',
    priceTime: '2026-08-21T09:17:00.000Z',
    source: 'vnstock',
  };

  function buildQuoteService(cache: CacheService, quote = VNM_QUOTE) {
    const getLatestPrices = jest.fn().mockResolvedValue(quote ? [quote] : []);
    const service = new MarketDataService(
      {
        getFxRates: jest.fn().mockResolvedValue([]),
        getMarketSymbolUniverse: jest.fn().mockResolvedValue([]),
      },
      { getLatestPrices },
      { listSymbols: jest.fn().mockResolvedValue([]) },
      {
        getGoldPrices: jest.fn().mockResolvedValue([]),
        getFxCounterRates: jest.fn().mockResolvedValue([]),
      },
      cache,
    );
    return { service, getLatestPrices };
  }

  /**
   * The dealer feed quotes one figure per lượng. A gold quote carries the whole
   * set, so switching the form's unit costs no second request — and the price
   * for the unit asked for is the backend's own, never rescaled by the caller.
   */
  it('ships every unit price with a gold quote', async () => {
    const cache = fakeCache();
    const service = new MarketDataService(
      {
        getFxRates: jest.fn().mockResolvedValue([]),
        getMarketSymbolUniverse: jest.fn().mockResolvedValue([]),
      },
      { getLatestPrices: jest.fn().mockResolvedValue([]) },
      { listSymbols: jest.fn().mockResolvedValue([]) },
      {
        getGoldPrices: jest.fn().mockResolvedValue([
          {
            name: 'VÀNG MIẾNG SJC',
            brand: 'Vàng SJC',
            karat: '',
            fineness: '',
            buyPrice: 11_000_000,
            sellPrice: 12_000_000,
            priceTime: '2026-08-31T00:00:00.000Z',
            source: 'giavangnet',
          },
        ]),
        getFxCounterRates: jest.fn().mockResolvedValue([]),
      },
      cache,
    );

    const quote = await service.getQuote({
      assetClass: 'gold',
      symbol: 'VÀNG MIẾNG SJC',
      unit: 'chỉ',
    });

    // `price`/`unit` state the one asked for; `unitPrices` carries them all.
    expect(quote?.price).toBe(1_200_000);
    expect(quote?.unit).toBe('chỉ');
    expect(quote?.unitPrices).toEqual({
      chỉ: 1_200_000,
      lượng: 12_000_000,
      gram: 320_000,
    });
  });

  it('prices a symbol the household does not hold yet', async () => {
    const cache = fakeCache();
    const { service, getLatestPrices } = buildQuoteService(cache);

    const quote = await service.getQuote({
      assetClass: 'stock',
      symbol: 'VNM',
      market: 'HOSE',
    });

    expect(quote).toEqual(VNM_QUOTE);
    // The universe is NOT consulted — that only covers held positions.
    expect(getLatestPrices).toHaveBeenCalledWith([
      expect.objectContaining({ symbol: 'VNM', quoteCurrency: 'VND' }),
    ]);
  });

  it('defaults a VN listing to VND and a foreign one to USD', async () => {
    const cache = fakeCache();
    const { service, getLatestPrices } = buildQuoteService(cache);

    await service.getQuote({
      assetClass: 'stock',
      symbol: 'VNM',
      market: 'HOSE',
    });
    await service.getQuote({
      assetClass: 'stock',
      symbol: 'AAPL',
      market: 'NASDAQ',
    });

    const currencyOfCall = (index: number): string =>
      (
        getLatestPrices.mock.calls[index] as [Array<{ quoteCurrency: string }>]
      )[0][0].quoteCurrency;
    expect(currencyOfCall(0)).toBe('VND');
    expect(currencyOfCall(1)).toBe('USD');
  });

  it('caches per (class, symbol, market, currency)', async () => {
    const cache = fakeCache();
    const { service, getLatestPrices } = buildQuoteService(cache);

    await service.getQuote({
      assetClass: 'stock',
      symbol: 'VNM',
      market: 'HOSE',
    });
    await service.getQuote({
      assetClass: 'stock',
      symbol: 'VNM',
      market: 'HOSE',
    });

    expect(getLatestPrices).toHaveBeenCalledTimes(1);
    expect(
      cache.store.has(cacheKeys.quote('stock', 'VNM', 'HOSE', 'VND', 'lượng')),
    ).toBe(true);
  });

  it('returns null for an unpriceable symbol instead of throwing', async () => {
    const cache = fakeCache();
    const { service } = buildQuoteService(cache, null as never);

    await expect(
      service.getQuote({ assetClass: 'stock', symbol: 'NOPE' }),
    ).resolves.toBeNull();
  });

  it('returns null when the query is incomplete', async () => {
    const cache = fakeCache();
    const { service, getLatestPrices } = buildQuoteService(cache);

    expect(await service.getQuote({ symbol: 'VNM' })).toBeNull();
    expect(await service.getQuote({ assetClass: 'stock' })).toBeNull();
    expect(getLatestPrices).not.toHaveBeenCalled();
  });
});

describe('MarketDataService.getQuote for gold and foreign currency', () => {
  const SJC: GoldPrice = {
    name: 'VÀNG MIẾNG SJC',
    brand: 'Vàng SJC',
    karat: '24k',
    fineness: '999.9',
    buyPrice: 14_460_000,
    sellPrice: 14_760_000,
    priceTime: '2026-08-21T09:17:00.000Z',
    source: 'btmc',
  };
  const NO_SELL: GoldPrice = {
    ...SJC,
    name: 'VÀNG NGUYÊN LIỆU',
    sellPrice: null,
  };
  const USD: FxCounterRate = {
    currencyCode: 'USD',
    currencyName: 'US DOLLAR',
    buyCash: 25_900,
    buyTransfer: 25_930,
    sell: 26_310,
    source: 'vnstock',
  };

  function buildCommodityService(gold: GoldPrice[], fx: FxCounterRate[]) {
    const getLatestPrices = jest.fn().mockResolvedValue([]);
    const service = new MarketDataService(
      {
        getFxRates: jest.fn().mockResolvedValue([]),
        getMarketSymbolUniverse: jest.fn().mockResolvedValue([]),
      },
      { getLatestPrices },
      { listSymbols: jest.fn().mockResolvedValue([]) },
      {
        getGoldPrices: jest.fn().mockResolvedValue(gold),
        getFxCounterRates: jest.fn().mockResolvedValue(fx),
      },
      fakeCache(),
    );
    return { service, getLatestPrices };
  }

  it('prices gold from the dealer sell side, in VND per lượng', async () => {
    const { service, getLatestPrices } = buildCommodityService([SJC], []);

    const quote = await service.getQuote({
      assetClass: 'gold',
      symbol: 'VÀNG MIẾNG SJC',
    });

    expect(quote).toMatchObject({
      assetClass: 'gold',
      symbol: 'VÀNG MIẾNG SJC',
      // The sell side: what the household pays to acquire it.
      price: 14_760_000,
      unit: 'lượng',
      quoteCurrency: 'VND',
      source: 'btmc',
    });
    // The instrument providers are not consulted for gold.
    expect(getLatestPrices).not.toHaveBeenCalled();
  });

  it('falls back to the buy side when the dealer does not sell the product', async () => {
    const { service } = buildCommodityService([NO_SELL], []);

    const quote = await service.getQuote({
      assetClass: 'gold',
      symbol: 'VÀNG NGUYÊN LIỆU',
    });

    expect(quote?.price).toBe(14_460_000);
  });

  it('prices a foreign currency from the bank sell rate', async () => {
    const { service } = buildCommodityService([], [USD]);

    const quote = await service.getQuote({
      assetClass: 'foreign_currency',
      symbol: 'USD',
    });

    expect(quote).toMatchObject({
      assetClass: 'foreign_currency',
      symbol: 'USD',
      price: 26_310,
      unit: 'USD',
      quoteCurrency: 'VND',
    });
  });

  it('returns null for a product or currency the feed does not carry', async () => {
    const { service } = buildCommodityService([SJC], [USD]);

    expect(
      await service.getQuote({ assetClass: 'gold', symbol: 'KHÔNG CÓ' }),
    ).toBeNull();
    expect(
      await service.getQuote({ assetClass: 'foreign_currency', symbol: 'EUR' }),
    ).toBeNull();
  });
});

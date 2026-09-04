import { CommodityPriceProvider } from './commodity-price.provider';
import { computeCurrentValue } from '../../../common/utils/money-space.utils';
import type { CacheService } from '../../../common/cache/cache.service';
import type { Asset } from '../../assets/entities/asset.entity';
import type { CommodityProvider } from './commodity-provider.interface';
import type { FxCounterRate } from '../entities/fx-rate.entity';
import type { GoldPrice } from '../entities/gold-price.entity';

const RING: GoldPrice = {
  name: 'NHẪN TRÒN TRƠN',
  brand: 'Vàng Rồng Thăng Long',
  karat: '24k',
  fineness: '999.9',
  buyPrice: 148_000_000,
  sellPrice: 150_000_000,
  priceTime: '2026-09-04T09:00:00.000Z',
  source: 'giavangnet',
};

const USD: FxCounterRate = {
  currencyCode: 'USD',
  currencyName: 'US DOLLAR',
  buyCash: 25_000,
  buyTransfer: 25_100,
  sell: 25_400,
  source: 'vcb',
};

/** Read-through stand-in for Redis, matching `CacheService.wrap`. */
function fakeCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    wrap: jest.fn(async (key: string, loader: () => Promise<unknown>) => {
      if (store.has(key)) return store.get(key);
      const value = await loader();
      store.set(key, value);
      return value;
    }),
  } as unknown as CacheService & { store: Map<string, unknown> };
}

function build(overrides: { gold?: GoldPrice[]; fx?: FxCounterRate[] } = {}) {
  const getGoldPrices = jest.fn().mockResolvedValue(overrides.gold ?? [RING]);
  const getFxCounterRates = jest.fn().mockResolvedValue(overrides.fx ?? [USD]);
  const commodity: CommodityProvider = { getGoldPrices, getFxCounterRates };
  const cache = fakeCache();
  return {
    provider: new CommodityPriceProvider(commodity, cache),
    getGoldPrices,
    getFxCounterRates,
    cache,
  };
}

describe('CommodityPriceProvider', () => {
  it('prices gold from the dealer sell side, per lượng', async () => {
    const { provider } = build();

    const quotes = await provider.getLatestPrices([
      { assetClass: 'gold', symbol: 'NHẪN TRÒN TRƠN', quoteCurrency: 'VND' },
    ]);

    expect(quotes).toEqual([
      expect.objectContaining({
        assetClass: 'gold',
        symbol: 'NHẪN TRÒN TRƠN',
        price: 150_000_000,
        unit: 'lượng',
        quoteCurrency: 'VND',
      }),
    ]);
    // Every unit rides along, as the gold endpoint's quotes do.
    expect(quotes[0].unitPrices).toEqual({
      chỉ: 15_000_000,
      lượng: 150_000_000,
      gram: 4_000_000,
    });
  });

  /**
   * The feed publishes one figure per lượng and nothing else; chỉ and gram are
   * always derived from it. This provider must hand that raw figure on with
   * `unit: 'lượng'` — `priceInPositionUnit` does the conversion downstream, so
   * converting here as well would divide twice (a holding in chỉ would price at
   * a tenth of the truth). `getQuote` converts because it answers a form asking
   * for one specific unit; this path does not.
   */
  it('emits the raw per-lượng figure, never a pre-converted one', async () => {
    const { provider } = build();

    const [quote] = await provider.getLatestPrices([
      { assetClass: 'gold', symbol: 'NHẪN TRÒN TRƠN', quoteCurrency: 'VND' },
    ]);

    expect(quote.unit).toBe('lượng');
    expect(quote.price).toBe(RING.sellPrice);
    // `price` and `unit` agree, so `unitPrices[quote.unit]` is the same figure.
    expect(quote.unitPrices?.[quote.unit]).toBe(quote.price);
  });

  it('falls back to the buy side for a product the dealer does not sell', async () => {
    const { provider } = build({ gold: [{ ...RING, sellPrice: null }] });

    const [quote] = await provider.getLatestPrices([
      { assetClass: 'gold', symbol: 'NHẪN TRÒN TRƠN', quoteCurrency: 'VND' },
    ]);

    expect(quote.price).toBe(148_000_000);
  });

  it('skips a symbol the feed does not quote rather than guessing', async () => {
    const { provider } = build();

    const quotes = await provider.getLatestPrices([
      { assetClass: 'gold', symbol: 'KHÔNG CÓ', quoteCurrency: 'VND' },
    ]);

    expect(quotes).toEqual([]);
  });

  it('prices foreign currency from the bank sell side', async () => {
    const { provider } = build();

    const quotes = await provider.getLatestPrices([
      { assetClass: 'foreign_currency', symbol: 'USD', quoteCurrency: 'VND' },
    ]);

    expect(quotes).toEqual([
      expect.objectContaining({
        assetClass: 'foreign_currency',
        symbol: 'USD',
        price: 25_400,
        unit: 'USD',
        quoteCurrency: 'VND',
      }),
    ]);
  });

  it('serves the whole batch from one upstream call per class', async () => {
    const { provider, getGoldPrices, getFxCounterRates } = build({
      gold: [RING, { ...RING, name: 'VÀNG MIẾNG SJC' }],
    });

    const quotes = await provider.getLatestPrices([
      { assetClass: 'gold', symbol: 'NHẪN TRÒN TRƠN', quoteCurrency: 'VND' },
      { assetClass: 'gold', symbol: 'VÀNG MIẾNG SJC', quoteCurrency: 'VND' },
      { assetClass: 'foreign_currency', symbol: 'USD', quoteCurrency: 'VND' },
    ]);

    expect(quotes).toHaveLength(3);
    expect(getGoldPrices).toHaveBeenCalledTimes(1);
    expect(getFxCounterRates).toHaveBeenCalledTimes(1);
  });

  it('does not touch an upstream no request needs', async () => {
    const { provider, getGoldPrices, getFxCounterRates } = build();

    await provider.getLatestPrices([
      { assetClass: 'gold', symbol: 'NHẪN TRÒN TRƠN', quoteCurrency: 'VND' },
    ]);

    expect(getFxCounterRates).not.toHaveBeenCalled();
    expect(getGoldPrices).toHaveBeenCalledTimes(1);
  });

  it('ignores classes the instrument providers own', async () => {
    const { provider, getGoldPrices, getFxCounterRates } = build();

    const quotes = await provider.getLatestPrices([
      { assetClass: 'stock', symbol: 'VNM', quoteCurrency: 'VND' },
    ]);

    expect(quotes).toEqual([]);
    expect(getGoldPrices).not.toHaveBeenCalled();
    expect(getFxCounterRates).not.toHaveBeenCalled();
  });

  /**
   * The regression this provider exists for: a gold holding had no route into
   * `getMarketPrices()`, so `computeCurrentValue` fell through to the stored
   * purchase price and never moved — on the live read and in the nightly
   * history capture alike.
   */
  it('lets computeCurrentValue price a holding in chỉ at the live quote', async () => {
    const { provider } = build();
    const asset = {
      id: 'a1',
      householdId: 'h1',
      name: 'NHẪN TRÒN TRƠN',
      type: 'gold',
      valuationMode: 'market_priced',
      liquidity: 'long_term',
      currency: 'VND',
      status: 'active',
      marketPosition: {
        assetClass: 'gold',
        symbol: 'NHẪN TRÒN TRƠN',
        market: 'Vàng Rồng Thăng Long',
        quantity: 12,
        unit: 'chỉ',
        quoteCurrency: 'VND',
        purchasePrice: 14_960_000,
      },
    } as unknown as Asset;

    const prices = await provider.getLatestPrices([
      { assetClass: 'gold', symbol: 'NHẪN TRÒN TRƠN', quoteCurrency: 'VND' },
    ]);

    // 12 chỉ x 15,000,000 — not 12 x the 14,960,000 purchase price.
    expect(computeCurrentValue(asset, prices, [], '2026-09-04')).toBe(
      180_000_000,
    );
  });

  /** A holding kept in the quoted unit must not be converted at all. */
  it('values a holding in lượng at the dealer figure itself', async () => {
    const { provider } = build();
    const asset = {
      valuationMode: 'market_priced',
      marketPosition: {
        assetClass: 'gold',
        symbol: 'NHẪN TRÒN TRƠN',
        quantity: 2,
        unit: 'lượng',
        quoteCurrency: 'VND',
        purchasePrice: 140_000_000,
      },
    } as unknown as Asset;

    const prices = await provider.getLatestPrices([
      { assetClass: 'gold', symbol: 'NHẪN TRÒN TRƠN', quoteCurrency: 'VND' },
    ]);

    expect(computeCurrentValue(asset, prices, [], '2026-09-04')).toBe(
      300_000_000,
    );
  });
});

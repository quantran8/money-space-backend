import { VnstockCommoditySymbolReferenceProvider } from './vnstock-commodity-symbol-reference.provider';
import type { CommodityProvider } from './commodity-provider.interface';
import type { GoldPrice } from '../entities/gold-price.entity';
import type { FxCounterRate } from '../entities/fx-rate.entity';

function gold(name: string, brand = 'Vàng SJC'): GoldPrice {
  return {
    name,
    brand,
    karat: '24k',
    fineness: '999.9',
    buyPrice: 14_400_000,
    sellPrice: 14_700_000,
    priceTime: '2026-08-21T09:17:00.000Z',
    source: 'btmc',
  };
}

function rate(currencyCode: string, currencyName: string): FxCounterRate {
  return {
    currencyCode,
    currencyName,
    buyCash: 25_900,
    buyTransfer: 25_930,
    sell: 26_310,
    source: 'vnstock',
  };
}

function build(overrides: Partial<CommodityProvider> = {}) {
  const getGoldPrices = jest
    .fn<Promise<GoldPrice[]>, []>()
    .mockResolvedValue([]);
  const getFxCounterRates = jest
    .fn<Promise<FxCounterRate[]>, []>()
    .mockResolvedValue([]);
  const commodity: CommodityProvider = {
    getGoldPrices,
    getFxCounterRates,
    ...overrides,
  };
  return {
    provider: new VnstockCommoditySymbolReferenceProvider(commodity),
    getGoldPrices,
    getFxCounterRates,
  };
}

describe('VnstockCommoditySymbolReferenceProvider gold', () => {
  it('lists only the allowlisted products, in allowlist order', async () => {
    const { provider } = build({
      getGoldPrices: jest
        .fn()
        .mockResolvedValue([
          gold('NHẪN TRÒN TRƠN', 'Vàng Rồng Thăng Long'),
          gold('VÀNG MIẾNG SJC'),
          gold('VÀNG MIẾNG VRTL', 'Vàng Rồng Thăng Long'),
        ]),
    });

    const result = await provider.listSymbols('gold');

    // Allowlist order, not feed order.
    expect(result.map((r) => r.symbol)).toEqual([
      'VÀNG MIẾNG SJC',
      'NHẪN TRÒN TRƠN',
      'VÀNG MIẾNG VRTL',
    ]);
  });

  it('lists silver from the feed after gold, sharing the same class', async () => {
    // Silver is taken whole from the feed rather than allowlisted, and shares
    // the `gold` class — the app has one precious-metal class.
    const { provider } = build({
      getGoldPrices: jest
        .fn()
        .mockResolvedValue([
          gold('BẠC THỎI 2025 ANCARAT 999 1 KG (1000 GRAM)', 'ANCARAT'),
          gold('VÀNG MIẾNG SJC'),
          gold('BẠC MIẾNG PHÚ QUÝ Ag 999 5 LƯỢNG', 'PHÚ QUÝ'),
        ]),
    });

    const result = await provider.listSymbols('gold');

    expect(result.map((r) => r.symbol)).toEqual([
      // Gold leads, in allowlist order...
      'VÀNG MIẾNG SJC',
      // ...then every silver product the feed carries.
      'BẠC THỎI 2025 ANCARAT 999 1 KG (1000 GRAM)',
      'BẠC MIẾNG PHÚ QUÝ Ag 999 5 LƯỢNG',
    ]);
    expect(result.every((r) => r.assetClass === 'gold')).toBe(true);
  });

  it('still drops gold rows that are neither allowlisted nor silver', async () => {
    const { provider } = build({
      getGoldPrices: jest
        .fn()
        .mockResolvedValue([
          gold('VÀNG MIẾNG SJC'),
          gold('VÀNG HỆ THỐNG', 'Quà Mừng Bản Vị Vàng'),
        ]),
    });

    const result = await provider.listSymbols('gold');

    expect(result.map((r) => r.symbol)).toEqual(['VÀNG MIẾNG SJC']);
  });

  it('skips an allowlisted product the dealer is not publishing today', async () => {
    // Offering it would create a holding nothing can price.
    const { provider } = build({
      getGoldPrices: jest.fn().mockResolvedValue([gold('VÀNG MIẾNG SJC')]),
    });

    const result = await provider.listSymbols('gold');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      assetClass: 'gold',
      symbol: 'VÀNG MIẾNG SJC',
      exchange: 'Vàng SJC',
      currency: 'VND',
      unit: 'lượng',
    });
  });

  it('caches the list so a second call does not re-hit the feed', async () => {
    const getGoldPrices = jest.fn().mockResolvedValue([gold('VÀNG MIẾNG SJC')]);
    const { provider } = build({ getGoldPrices });

    await provider.listSymbols('gold');
    await provider.listSymbols('gold');

    expect(getGoldPrices).toHaveBeenCalledTimes(1);
  });

  it('never caches an empty list, so a recovered feed is picked up', async () => {
    const getGoldPrices = jest.fn().mockResolvedValue([]);
    const { provider } = build({ getGoldPrices });

    expect(await provider.listSymbols('gold')).toEqual([]);

    getGoldPrices.mockResolvedValue([gold('VÀNG MIẾNG SJC')]);
    expect(await provider.listSymbols('gold')).toHaveLength(1);
  });
});

describe('VnstockCommoditySymbolReferenceProvider foreign currency', () => {
  it('lists the supported currencies the bank quotes', async () => {
    const { provider } = build({
      getFxCounterRates: jest
        .fn()
        .mockResolvedValue([
          rate('USD', 'US DOLLAR'),
          rate('JPY', 'JAPANESE YEN'),
          rate('EUR', 'EURO'),
        ]),
    });

    const result = await provider.listSymbols('foreign_currency');

    // EUR is quoted but not supported, so it is not offered.
    expect(result.map((r) => r.symbol)).toEqual(['USD', 'JPY']);
    expect(result[0]).toMatchObject({
      assetClass: 'foreign_currency',
      symbol: 'USD',
      currency: 'VND',
      unit: 'USD',
    });
  });

  it('skips a supported currency the bank is not quoting', async () => {
    const { provider } = build({
      getFxCounterRates: jest
        .fn()
        .mockResolvedValue([rate('USD', 'US DOLLAR')]),
    });

    const result = await provider.listSymbols('foreign_currency');

    expect(result.map((r) => r.symbol)).toEqual(['USD']);
  });
});

describe('VnstockCommoditySymbolReferenceProvider routing', () => {
  it.each(['stock', 'crypto'] as const)(
    'never lists %s — that class has its own provider',
    async (assetClass) => {
      const { provider, getGoldPrices, getFxCounterRates } = build();

      expect(await provider.listSymbols(assetClass)).toEqual([]);
      expect(getGoldPrices).not.toHaveBeenCalled();
      expect(getFxCounterRates).not.toHaveBeenCalled();
    },
  );
});

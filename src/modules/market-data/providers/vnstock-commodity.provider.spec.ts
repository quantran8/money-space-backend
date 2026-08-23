import { VnstockCommodityProvider } from './vnstock-commodity.provider';

const goldPrice = jest.fn<Promise<unknown>, []>();
const exchange = jest.fn<Promise<unknown>, []>();

jest.mock('vnstock-js', () => ({
  commodity: {
    gold: { price: (): Promise<unknown> => goldPrice() },
    exchange: (): Promise<unknown> => exchange(),
  },
}));

describe('VnstockCommodityProvider gold', () => {
  beforeEach(() => {
    goldPrice.mockReset();
  });

  it('parses a dealer quote, splitting product from brand', async () => {
    goldPrice.mockResolvedValue({
      source: 'btmc',
      data: [
        {
          name: 'VÀNG MIẾNG SJC (Vàng SJC)',
          karat: '24k',
          weight: '999.9',
          buyPrice: '14400000',
          sellPrice: '14700000',
          updatedAt: '21/08/2026 16:17',
        },
      ],
    });
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result).toEqual([
      {
        name: 'VÀNG MIẾNG SJC',
        brand: 'Vàng SJC',
        karat: '24k',
        fineness: '999.9',
        buyPrice: 14_400_000,
        sellPrice: 14_700_000,
        // 16:17 Vietnam time (UTC+7) is 09:17 UTC.
        priceTime: '2026-08-21T09:17:00.000Z',
        source: 'btmc',
      },
    ]);
  });

  it('keeps only the most recent row per product', async () => {
    // The feed republishes each product at several times the same day.
    goldPrice.mockResolvedValue({
      source: 'btmc',
      data: [
        {
          name: 'VÀNG MIẾNG SJC (Vàng SJC)',
          buyPrice: '14400000',
          sellPrice: '14700000',
          updatedAt: '21/08/2026 16:17',
        },
        {
          name: 'VÀNG MIẾNG SJC (Vàng SJC)',
          buyPrice: '14360000',
          sellPrice: '14660000',
          updatedAt: '21/08/2026 09:00',
        },
      ],
    });
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result).toHaveLength(1);
    expect(result[0].buyPrice).toBe(14_400_000);
  });

  it('reports an unquoted sell side as null, never as a free price', async () => {
    goldPrice.mockResolvedValue({
      source: 'btmc',
      data: [
        {
          name: 'VÀNG NGUYÊN LIỆU (Vàng thị trường)',
          buyPrice: '13650000',
          sellPrice: '0',
          updatedAt: '21/08/2026 16:17',
        },
      ],
    });
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result[0].sellPrice).toBeNull();
    expect(result[0].buyPrice).toBe(13_650_000);
  });

  it('drops a row with neither side priced', async () => {
    goldPrice.mockResolvedValue({
      source: 'btmc',
      data: [{ name: 'X (Y)', buyPrice: '0', sellPrice: '0' }],
    });
    const provider = new VnstockCommodityProvider();

    expect(await provider.getGoldPrices()).toEqual([]);
  });

  it('handles a name with no brand in parentheses', async () => {
    goldPrice.mockResolvedValue({
      source: 'btmc',
      data: [{ name: 'VÀNG TRƠN', buyPrice: '100', updatedAt: '21/08/2026' }],
    });
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result[0]).toMatchObject({ name: 'VÀNG TRƠN', brand: '' });
  });

  it('returns [] when the upstream fails, never throwing', async () => {
    goldPrice.mockRejectedValue(new Error('403 Forbidden'));
    const provider = new VnstockCommodityProvider();

    await expect(provider.getGoldPrices()).resolves.toEqual([]);
  });

  it('tolerates a malformed payload', async () => {
    goldPrice.mockResolvedValue({ source: 'btmc', data: null });
    const provider = new VnstockCommodityProvider();

    await expect(provider.getGoldPrices()).resolves.toEqual([]);
  });
});

describe('VnstockCommodityProvider FX counter rates', () => {
  beforeEach(() => {
    exchange.mockReset();
  });

  it('parses a bank row into numbers', async () => {
    exchange.mockResolvedValue([
      {
        currencyCode: 'USD',
        currencyName: 'US DOLLAR',
        buyCash: '25900.00',
        buyTransfer: '25930.00',
        sell: '26310.00',
      },
    ]);
    const provider = new VnstockCommodityProvider();

    const result = await provider.getFxCounterRates();

    expect(result).toEqual([
      {
        currencyCode: 'USD',
        currencyName: 'US DOLLAR',
        buyCash: 25_900,
        buyTransfer: 25_930,
        sell: 26_310,
        source: 'vnstock',
      },
    ]);
  });

  it('reports a leg the bank does not quote as null', async () => {
    // Several currencies are transfer-only; upstream sends cash as "0.00".
    exchange.mockResolvedValue([
      {
        currencyCode: 'SEK',
        currencyName: 'SWEDISH KRONA',
        buyCash: '0.00',
        buyTransfer: '2703.26',
        sell: '2817.91',
      },
    ]);
    const provider = new VnstockCommodityProvider();

    const result = await provider.getFxCounterRates();

    expect(result[0].buyCash).toBeNull();
    expect(result[0].buyTransfer).toBe(2703.26);
  });

  it('keeps small per-unit rates as published', async () => {
    // JPY/KRW are quoted per single unit here, verified against cross-rates —
    // no per-100 rescaling may be applied.
    exchange.mockResolvedValue([
      {
        currencyCode: 'JPY',
        currencyName: 'JAPANESE YEN',
        buyCash: '158.61',
        buyTransfer: '160.21',
        sell: '169.55',
      },
    ]);
    const provider = new VnstockCommodityProvider();

    const result = await provider.getFxCounterRates();

    expect(result[0].sell).toBe(169.55);
  });

  it('drops a currency with no quoted leg', async () => {
    exchange.mockResolvedValue([
      { currencyCode: 'XXX', buyCash: '0', buyTransfer: '0', sell: '0' },
    ]);
    const provider = new VnstockCommodityProvider();

    expect(await provider.getFxCounterRates()).toEqual([]);
  });

  it('returns [] when the upstream fails, never throwing', async () => {
    exchange.mockRejectedValue(new Error('ECONNRESET'));
    const provider = new VnstockCommodityProvider();

    await expect(provider.getFxCounterRates()).resolves.toEqual([]);
  });

  it('gives up on a hung upstream instead of holding the request', async () => {
    // Production symptom: vnstock retries 3x15s internally, so a slow dealer
    // feed held /symbols for ~48s. The provider caps it at COMMODITY_TIMEOUT_MS
    // (default 4s) and falls back rather than waiting the full retry budget.
    goldPrice.mockReturnValue(new Promise(() => undefined));
    const provider = new VnstockCommodityProvider();

    const started = Date.now();
    const result = await provider.getGoldPrices();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(15_000);
    expect(result).toEqual([]);
  }, 20_000);

  it('serves the last good list when a later call fails', async () => {
    // Returning [] would make getQuote report "no such product" — the null the
    // quote endpoint was returning in production.
    goldPrice.mockResolvedValue({
      source: 'btmc',
      data: [
        {
          name: 'NHẪN TRÒN TRƠN (Vàng Rồng Thăng Long)',
          buyPrice: '14550000',
          sellPrice: '14950000',
          updatedAt: '22/08/2026 10:43',
        },
      ],
    });
    const provider = new VnstockCommodityProvider();
    expect(await provider.getGoldPrices()).toHaveLength(1);

    goldPrice.mockRejectedValue(new Error('ECONNRESET'));
    const afterFailure = await provider.getGoldPrices();

    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0].name).toBe('NHẪN TRÒN TRƠN');
  });

  it('coalesces concurrent callers onto one upstream call', async () => {
    goldPrice.mockReset();
    goldPrice.mockResolvedValue({ source: 'btmc', data: [] });
    const provider = new VnstockCommodityProvider();

    await Promise.all([provider.getGoldPrices(), provider.getGoldPrices()]);

    expect(goldPrice).toHaveBeenCalledTimes(1);
  });
});

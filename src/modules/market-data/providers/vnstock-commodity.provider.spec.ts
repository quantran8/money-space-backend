import { VnstockCommodityProvider } from './vnstock-commodity.provider';

const goldPrice = jest.fn<Promise<unknown>, [{ source?: string }?]>();
const exchange = jest.fn<Promise<unknown>, []>();

jest.mock('vnstock-js', () => ({
  commodity: {
    gold: {
      price: (options?: { source?: string }): Promise<unknown> =>
        goldPrice(options),
    },
    exchange: (): Promise<unknown> => exchange(),
  },
}));

/**
 * A short BTMC body is treated as truncated, so a fixture must clear
 * `MIN_GOLD_ROWS`. Pads with filler rows the parser drops (no price).
 */
const btmc = (rows: unknown[]): { source: string; data: unknown[] } => ({
  source: 'btmc',
  data: [
    ...rows,
    ...Array.from({ length: 25 }, (_, i) => ({
      name: `FILLER ${i} (Filler)`,
      buyPrice: '0',
      sellPrice: '0',
    })),
  ],
});

describe('VnstockCommodityProvider gold', () => {
  beforeEach(() => {
    goldPrice.mockReset();
  });

  it('parses a dealer quote, splitting product from brand', async () => {
    goldPrice.mockResolvedValue(
      btmc([
        {
          name: 'VÀNG MIẾNG SJC (Vàng SJC)',
          karat: '24k',
          weight: '999.9',
          buyPrice: '14400000',
          sellPrice: '14700000',
          updatedAt: '21/08/2026 16:17',
        },
      ]),
    );
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
    goldPrice.mockResolvedValue(
      btmc([
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
      ]),
    );
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result).toHaveLength(1);
    expect(result[0].buyPrice).toBe(14_400_000);
  });

  it('reports an unquoted sell side as null, never as a free price', async () => {
    goldPrice.mockResolvedValue(
      btmc([
        {
          name: 'VÀNG NGUYÊN LIỆU (Vàng thị trường)',
          buyPrice: '13650000',
          sellPrice: '0',
          updatedAt: '21/08/2026 16:17',
        },
      ]),
    );
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result[0].sellPrice).toBeNull();
    expect(result[0].buyPrice).toBe(13_650_000);
  });

  it('drops a row with neither side priced', async () => {
    goldPrice.mockResolvedValue(
      btmc([{ name: 'X (Y)', buyPrice: '0', sellPrice: '0' }]),
    );
    const provider = new VnstockCommodityProvider();

    expect(await provider.getGoldPrices()).toEqual([]);
  });

  it('handles a name with no brand in parentheses', async () => {
    goldPrice.mockResolvedValue(
      btmc([{ name: 'VÀNG TRƠN', buyPrice: '100', updatedAt: '21/08/2026' }]),
    );
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

  it('falls back to giavangnet when btmc hangs', async () => {
    // Production symptom: vnstock retries 3x15s internally, so a slow dealer
    // feed held /symbols for ~48s. The provider caps it at COMMODITY_TIMEOUT_MS
    // and must reach the secondary feed — a hung btmc used to throw straight
    // past it, so giavangnet never ran in prod, the one env it exists for.
    goldPrice.mockImplementation((options) =>
      options?.source === 'giavangnet'
        ? Promise.resolve({
            source: 'giavangnet',
            data: [
              {
                code: 'BTSJC',
                buyPrice: '14400000',
                sellPrice: '14700000',
                updatedAt: 1_756_000_000,
              },
            ],
          })
        : new Promise(() => undefined),
    );
    const provider = new VnstockCommodityProvider();

    const started = Date.now();
    const result = await provider.getGoldPrices();
    const elapsed = Date.now() - started;

    // One btmc round, not two: a timeout is not retried.
    expect(elapsed).toBeLessThan(15_000);
    expect(goldPrice).toHaveBeenCalledWith({ source: 'giavangnet' });
    expect(result).toEqual([
      expect.objectContaining({
        name: 'VÀNG MIẾNG SJC',
        brand: 'Vàng SJC',
        buyPrice: 14_400_000,
        sellPrice: 14_700_000,
        source: 'giavangnet',
      }),
    ]);
  }, 20_000);

  it('serves the stale list when btmc hangs and giavangnet fails too', async () => {
    goldPrice.mockReturnValue(new Promise(() => undefined));
    const provider = new VnstockCommodityProvider();

    await expect(provider.getGoldPrices()).resolves.toEqual([]);
  }, 30_000);

  it('serves the last good list when a later call fails', async () => {
    // Returning [] would make getQuote report "no such product" — the null the
    // quote endpoint was returning in production.
    goldPrice.mockResolvedValue(
      btmc([
        {
          name: 'NHẪN TRÒN TRƠN (Vàng Rồng Thăng Long)',
          buyPrice: '14550000',
          sellPrice: '14950000',
          updatedAt: '22/08/2026 10:43',
        },
      ]),
    );
    const provider = new VnstockCommodityProvider();
    expect(await provider.getGoldPrices()).toHaveLength(1);

    goldPrice.mockRejectedValue(new Error('ECONNRESET'));
    const afterFailure = await provider.getGoldPrices();

    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0].name).toBe('NHẪN TRÒN TRƠN');
  });

  it('rejects a truncated btmc body instead of caching the few products in it', async () => {
    goldPrice.mockReset();
    // A cut-off body parses fine and would otherwise drop most of the list.
    const truncated = {
      source: 'btmc',
      data: [
        { name: 'VÀNG MIẾNG SJC (Vàng SJC)', buyPrice: '1', sellPrice: '2' },
      ],
    };
    goldPrice.mockResolvedValue(truncated);
    const provider = new VnstockCommodityProvider();

    await provider.getGoldPrices();

    // Two btmc attempts, then the giavangnet fallback.
    expect(goldPrice).toHaveBeenCalledTimes(3);
    expect(goldPrice).toHaveBeenLastCalledWith({ source: 'giavangnet' });
  });

  it('maps giavangnet codes onto the products the allowlist names', async () => {
    goldPrice.mockReset();
    goldPrice.mockImplementation((options) =>
      Promise.resolve(
        options?.source === 'giavangnet'
          ? {
              source: 'giavangnet',
              data: [
                {
                  code: 'BTSJC',
                  buyPrice: 144600000,
                  sellPrice: 147600000,
                  updatedAt: 1787443201,
                },
                {
                  code: 'BT9999NTT',
                  buyPrice: 145500000,
                  sellPrice: 149500000,
                  updatedAt: 1787443201,
                },
                // An index, not a retail product — must not be listed.
                { code: 'XAUUSD', buyPrice: 4604.4, sellPrice: 0 },
              ],
            }
          : { source: 'btmc', data: [] },
      ),
    );
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result.map((item) => item.name)).toEqual([
      'VÀNG MIẾNG SJC',
      'NHẪN TRÒN TRƠN',
    ]);
    expect(result[0]).toMatchObject({
      brand: 'Vàng SJC',
      buyPrice: 144_600_000,
      sellPrice: 147_600_000,
      source: 'giavangnet',
      priceTime: '2026-08-23T00:00:01.000Z',
    });
  });

  it('coalesces concurrent callers onto one upstream call', async () => {
    goldPrice.mockReset();
    goldPrice.mockResolvedValue(
      btmc([
        { name: 'VÀNG MIẾNG SJC (Vàng SJC)', buyPrice: '1', sellPrice: '2' },
      ]),
    );
    const provider = new VnstockCommodityProvider();

    await Promise.all([provider.getGoldPrices(), provider.getGoldPrices()]);

    expect(goldPrice).toHaveBeenCalledTimes(1);
  });
});

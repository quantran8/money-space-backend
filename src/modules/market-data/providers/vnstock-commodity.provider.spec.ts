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

/** giavang.net payload; rows are keyed by `code` and carry no product name. */
const gvn = (rows: unknown[]): { source: string; data: unknown[] } => ({
  source: 'giavangnet',
  data: rows,
});

/** giavangnet rows older than a week are dropped, so fixtures must be current. */
const today = (): string => new Date().toISOString().slice(0, 10);

describe('VnstockCommodityProvider gold', () => {
  beforeEach(() => {
    goldPrice.mockReset();
  });

  it('maps a code onto its product and parses the prices', async () => {
    goldPrice.mockResolvedValue(
      gvn([
        {
          code: 'BTSJC',
          name: 'GOLD',
          buyPrice: 147_300_000,
          sellPrice: 150_300_000,
          updatedAt: today(),
        },
      ]),
    );
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result).toEqual([
      {
        name: 'VÀNG MIẾNG SJC',
        brand: 'Vàng SJC',
        karat: '',
        fineness: '',
        buyPrice: 147_300_000,
        sellPrice: 150_300_000,
        priceTime: expect.any(String) as string,
        source: 'giavangnet',
      },
    ]);
  });

  it('lists each dealer separately rather than collapsing them', async () => {
    // The per-dealer spread is the point of the feed: DOJI's nhẫn quotes
    // higher than SJC. Collapsing them onto one name threw the list away.
    goldPrice.mockResolvedValue(
      gvn([
        {
          code: 'BTSJC',
          buyPrice: 147_300_000,
          sellPrice: 150_300_000,
          updatedAt: today(),
        },
        {
          code: 'DOHCML',
          buyPrice: 147_000_000,
          sellPrice: 150_000_000,
          updatedAt: today(),
        },
        {
          code: 'DOJINHTV',
          buyPrice: 148_900_000,
          sellPrice: 152_900_000,
          updatedAt: today(),
        },
      ]),
    );
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result.map((r) => r.name)).toEqual([
      'VÀNG MIẾNG SJC',
      'VÀNG MIẾNG DOJI HCM',
      'VÀNG MIẾNG VRTL',
    ]);
  });

  it('ignores index rows that are not retail products', async () => {
    goldPrice.mockResolvedValue(
      gvn([
        { code: 'XAUUSD', buyPrice: 4634.5, sellPrice: 0, updatedAt: today() },
        { code: 'USDX', buyPrice: 96.86, sellPrice: 0, updatedAt: today() },
        {
          code: 'BTSJC',
          buyPrice: 147_300_000,
          sellPrice: 150_300_000,
          updatedAt: today(),
        },
      ]),
    );
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('VÀNG MIẾNG SJC');
  });

  it('reports an unquoted sell side as null, never as a free price', async () => {
    goldPrice.mockResolvedValue(
      gvn([
        {
          code: 'BTSJC',
          buyPrice: 147_300_000,
          sellPrice: 0,
          updatedAt: today(),
        },
      ]),
    );
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result[0].sellPrice).toBeNull();
    expect(result[0].buyPrice).toBe(147_300_000);
  });

  it('drops a row with neither side priced', async () => {
    goldPrice.mockResolvedValue(
      gvn([{ code: 'BTSJC', buyPrice: 0, sellPrice: 0, updatedAt: today() }]),
    );
    const provider = new VnstockCommodityProvider();

    await expect(provider.getGoldPrices()).resolves.toEqual([]);
  });

  it('keeps the first code when several quote the same product', async () => {
    goldPrice.mockResolvedValue(
      gvn([
        {
          code: 'BTSJC',
          buyPrice: 147_300_000,
          sellPrice: 150_300_000,
          updatedAt: today(),
        },
        { code: 'BTSJC', buyPrice: 1, sellPrice: 2, updatedAt: today() },
      ]),
    );
    const provider = new VnstockCommodityProvider();

    const result = await provider.getGoldPrices();

    expect(result).toHaveLength(1);
    expect(result[0].buyPrice).toBe(147_300_000);
  });

  it('returns [] when the upstream fails, never throwing', async () => {
    goldPrice.mockRejectedValue(new Error('ECONNRESET'));
    const provider = new VnstockCommodityProvider();

    await expect(provider.getGoldPrices()).resolves.toEqual([]);
  });

  it('tolerates a malformed payload', async () => {
    goldPrice.mockResolvedValue({ source: 'giavangnet', data: null });
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

  it('serves the last good list when a later call fails', async () => {
    // Returning [] would make getQuote report "no such product" — the null the
    // quote endpoint was returning in production.
    goldPrice.mockResolvedValue(
      gvn([
        {
          code: 'BT9999NTT',
          buyPrice: 149_700_000,
          sellPrice: 153_700_000,
          updatedAt: today(),
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

  it('drops a giavangnet row the feed has stopped updating', async () => {
    // VNGN still ships at its 2025-05-07 price; stamping it "now" would
    // publish a 15-month-old figure as today's.
    goldPrice.mockReset();
    goldPrice.mockImplementation((options) =>
      Promise.resolve(
        options?.source === 'giavangnet'
          ? {
              source: 'giavangnet',
              data: [
                {
                  code: 'BTSJC',
                  buyPrice: '147300000',
                  sellPrice: '150300000',
                  updatedAt: '2025-05-07',
                },
              ],
            }
          : { source: 'btmc', data: [] },
      ),
    );
    const provider = new VnstockCommodityProvider();

    await expect(provider.getGoldPrices()).resolves.toEqual([]);
  });

  it('coalesces concurrent callers onto one upstream call', async () => {
    goldPrice.mockReset();
    goldPrice.mockResolvedValue(
      gvn([{ code: 'BTSJC', buyPrice: 1, sellPrice: 2, updatedAt: today() }]),
    );
    const provider = new VnstockCommodityProvider();

    await Promise.all([provider.getGoldPrices(), provider.getGoldPrices()]);

    expect(goldPrice).toHaveBeenCalledTimes(1);
  });
});

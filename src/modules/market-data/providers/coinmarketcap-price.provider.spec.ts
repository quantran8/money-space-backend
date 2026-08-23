import { CoinMarketCapPriceProvider } from './coinmarketcap-price.provider';
import type { SymbolRequest } from './symbol-request';

describe('CoinMarketCapPriceProvider', () => {
  const originalKey = process.env.COIN_MARKETCAP_API_KEY;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.COIN_MARKETCAP_API_KEY = originalKey;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockFetchJson(body: unknown, ok = true, status = 200) {
    const fetchMock: jest.Mock<Promise<Response>, [URL, RequestInit?]> = jest
      .fn<Promise<Response>, [URL, RequestInit?]>()
      .mockResolvedValue({
        ok,
        status,
        json: () => Promise.resolve(body),
      } as Response);
    global.fetch = fetchMock;
    return fetchMock;
  }

  function firstFetchUrl(
    fetchMock: jest.Mock<Promise<Response>, [URL, RequestInit?]>,
  ): URL {
    return fetchMock.mock.calls[0][0];
  }

  it('returns [] and never calls fetch when no API key is set', async () => {
    delete process.env.COIN_MARKETCAP_API_KEY;
    const fetchMock = mockFetchJson({});
    const provider = new CoinMarketCapPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
    ]);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The asset form's money fields are đồng, so it asks for the quote in VND and
  // prefills the purchase price from it. That only works if `convert` is
  // forwarded and the VND key is the one read back off the response.
  it('quotes in VND when asked, so the đồng price can be prefilled', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    const fetchMock = mockFetchJson({
      data: {
        BTC: [{ symbol: 'BTC', quote: { VND: { price: 2_050_000_000 } } }],
      },
    });
    const provider = new CoinMarketCapPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'VND' },
    ]);

    expect(firstFetchUrl(fetchMock).searchParams.get('convert')).toBe('VND');
    expect(result).toEqual([
      expect.objectContaining({
        symbol: 'BTC',
        price: 2_050_000_000,
        quoteCurrency: 'VND',
      }),
    ]);
  });

  it('batches crypto symbols into one call and maps quotes back', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    const fetchMock = mockFetchJson({
      data: {
        BTC: [{ symbol: 'BTC', quote: { USD: { price: 65000 } } }],
        ETH: [{ symbol: 'ETH', quote: { USD: { price: 3200.5 } } }],
      },
    });
    const provider = new CoinMarketCapPriceProvider();
    const requests: SymbolRequest[] = [
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
      { assetClass: 'crypto', symbol: 'ETH', quoteCurrency: 'USD' },
    ];

    const result = await provider.getLatestPrices(requests);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = firstFetchUrl(fetchMock);
    expect(url.searchParams.get('symbol')).toBe('BTC,ETH');
    expect(url.searchParams.get('convert')).toBe('USD');
    // The key travels as a header, never in the query string.
    const init = fetchMock.mock.calls[0][1];
    expect((init?.headers as Record<string, string>)['X-CMC_PRO_API_KEY']).toBe(
      'test-key',
    );

    expect(result).toHaveLength(2);
    expect(result.find((q) => q.symbol === 'BTC')).toMatchObject({
      assetClass: 'crypto',
      price: 65000,
      quoteCurrency: 'USD',
      source: 'coinmarketcap',
    });
    expect(result.find((q) => q.symbol === 'ETH')?.price).toBe(3200.5);
  });

  it('accepts a v1-style bare object entry as well as a v2 array', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    mockFetchJson({
      data: { BTC: { symbol: 'BTC', quote: { USD: { price: 65000 } } } },
    });
    const provider = new CoinMarketCapPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
    ]);

    expect(result).toEqual([
      expect.objectContaining({ symbol: 'BTC', price: 65000 }),
    ]);
  });

  it('picks the highest-ranked coin when a ticker maps to several', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    mockFetchJson({
      data: {
        UNI: [
          { symbol: 'UNI', name: 'Uniswap', quote: { USD: { price: 10 } } },
          { symbol: 'UNI', name: 'Unicorn', quote: { USD: { price: 0.01 } } },
        ],
      },
    });
    const provider = new CoinMarketCapPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'crypto', symbol: 'UNI', quoteCurrency: 'USD' },
    ]);

    expect(result[0].price).toBe(10);
  });

  it('issues one call per convert-currency', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    const fetchMock = mockFetchJson({
      data: {
        BTC: [
          { quote: { USD: { price: 65000 }, VND: { price: 1_600_000_000 } } },
        ],
      },
    });
    const provider = new CoinMarketCapPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'VND' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result.map((q) => q.quoteCurrency).sort()).toEqual(['USD', 'VND']);
  });

  it('reduces a pair-formatted symbol to its base ticker', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    const fetchMock = mockFetchJson({
      data: { BTC: [{ quote: { USD: { price: 65000 } } }] },
    });
    const provider = new CoinMarketCapPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'crypto', symbol: 'BTC/USD', quoteCurrency: 'USD' },
    ]);

    expect(firstFetchUrl(fetchMock).searchParams.get('symbol')).toBe('BTC');
    // The quote maps back to the position's own symbol, not the sent ticker.
    expect(result[0].symbol).toBe('BTC/USD');
  });

  it('honours an explicit providerSymbol override', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    const fetchMock = mockFetchJson({
      data: { WBTC: [{ quote: { USD: { price: 64900 } } }] },
    });
    const provider = new CoinMarketCapPriceProvider();

    const result = await provider.getLatestPrices([
      {
        assetClass: 'crypto',
        symbol: 'BTCB',
        providerSymbol: 'WBTC',
        quoteCurrency: 'USD',
      },
    ]);

    expect(firstFetchUrl(fetchMock).searchParams.get('symbol')).toBe('WBTC');
    expect(result[0]).toMatchObject({ symbol: 'BTCB', price: 64900 });
  });

  it('skips a symbol missing from the response but keeps the good quotes', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    mockFetchJson({
      data: { BTC: [{ quote: { USD: { price: 65000 } } }] },
    });
    const provider = new CoinMarketCapPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
      { assetClass: 'crypto', symbol: 'NOPE', quoteCurrency: 'USD' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('BTC');
  });

  it('returns [] on a top-level API error without throwing', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    mockFetchJson({
      status: { error_code: 1008, error_message: 'rate limit reached' },
    });
    const provider = new CoinMarketCapPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
    ]);

    expect(result).toEqual([]);
  });

  it('returns [] on an HTTP error without throwing', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    mockFetchJson({}, false, 401);
    const provider = new CoinMarketCapPriceProvider();

    await expect(
      provider.getLatestPrices([
        { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
      ]),
    ).resolves.toEqual([]);
  });

  it('returns [] when a network error is thrown, never propagating it', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const provider = new CoinMarketCapPriceProvider();

    await expect(
      provider.getLatestPrices([
        { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
      ]),
    ).resolves.toEqual([]);
  });

  it('ignores non-crypto classes entirely', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    const fetchMock = mockFetchJson({});
    const provider = new CoinMarketCapPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'stock', symbol: 'AAPL', quoteCurrency: 'USD' },
      { assetClass: 'gold', symbol: 'XAU', quoteCurrency: 'USD' },
    ]);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

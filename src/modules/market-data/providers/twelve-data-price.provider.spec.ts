import { TwelveDataPriceProvider } from './twelve-data-price.provider';
import type { SymbolRequest } from './symbol-request';

describe('TwelveDataPriceProvider', () => {
  const originalKey = process.env.TWELVEDATA_API_KEY;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.TWELVEDATA_API_KEY = originalKey;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockFetchJson(body: unknown, ok = true, status = 200) {
    const fetchMock: jest.Mock<Promise<Response>, [URL]> = jest
      .fn<Promise<Response>, [URL]>()
      .mockResolvedValue({
        ok,
        status,
        json: () => Promise.resolve(body),
      } as Response);
    global.fetch = fetchMock;
    return fetchMock;
  }

  /** The URL passed to the mocked fetch on its first call. */
  function firstFetchUrl(fetchMock: jest.Mock<Promise<Response>, [URL]>): URL {
    return fetchMock.mock.calls[0][0];
  }

  it('returns [] and never calls fetch when no API key is set', async () => {
    delete process.env.TWELVEDATA_API_KEY;
    const fetchMock = mockFetchJson({});
    const provider = new TwelveDataPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'stock', symbol: 'AAPL', quoteCurrency: 'USD' },
    ]);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a keyed batch response back to (assetClass, symbol) quotes', async () => {
    process.env.TWELVEDATA_API_KEY = 'test-key';
    const fetchMock = mockFetchJson({
      AAPL: { price: '190.50' },
      'BTC/USD': { price: '65000.00' },
    });
    const provider = new TwelveDataPriceProvider();
    const requests: SymbolRequest[] = [
      { assetClass: 'stock', symbol: 'AAPL', quoteCurrency: 'USD' },
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
    ];

    const result = await provider.getLatestPrices(requests);

    // Crypto is requested as a SYMBOL/USD pair.
    const url = firstFetchUrl(fetchMock);
    expect(url.searchParams.get('symbol')).toBe('AAPL,BTC/USD');
    expect(url.searchParams.get('apikey')).toBe('test-key');

    expect(result).toHaveLength(2);
    const aapl = result.find((q) => q.symbol === 'AAPL');
    expect(aapl).toMatchObject({
      assetClass: 'stock',
      price: 190.5,
      source: 'twelvedata',
    });
    const btc = result.find((q) => q.symbol === 'BTC');
    expect(btc).toMatchObject({ assetClass: 'crypto', price: 65000 });
  });

  it('normalises a single-symbol un-keyed response', async () => {
    process.env.TWELVEDATA_API_KEY = 'test-key';
    mockFetchJson({ price: '190.50' });
    const provider = new TwelveDataPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'stock', symbol: 'AAPL', quoteCurrency: 'USD' },
    ]);

    expect(result).toEqual([
      expect.objectContaining({ symbol: 'AAPL', price: 190.5 }),
    ]);
  });

  it('skips a per-symbol error but keeps the good quotes', async () => {
    process.env.TWELVEDATA_API_KEY = 'test-key';
    mockFetchJson({
      AAPL: { price: '190.50' },
      NOPE: { status: 'error', code: 404, message: 'symbol not found' },
    });
    const provider = new TwelveDataPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'stock', symbol: 'AAPL', quoteCurrency: 'USD' },
      { assetClass: 'stock', symbol: 'NOPE', quoteCurrency: 'USD' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('AAPL');
  });

  it('returns [] on a top-level API error without throwing', async () => {
    process.env.TWELVEDATA_API_KEY = 'test-key';
    mockFetchJson({ status: 'error', code: 429, message: 'rate limit' });
    const provider = new TwelveDataPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'stock', symbol: 'AAPL', quoteCurrency: 'USD' },
    ]);

    expect(result).toEqual([]);
  });

  it('returns [] when a network error is thrown, never propagating it', async () => {
    process.env.TWELVEDATA_API_KEY = 'test-key';
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const provider = new TwelveDataPriceProvider();

    await expect(
      provider.getLatestPrices([
        { assetClass: 'stock', symbol: 'AAPL', quoteCurrency: 'USD' },
      ]),
    ).resolves.toEqual([]);
  });

  it('ignores unsupported asset classes (gold, foreign_currency)', async () => {
    process.env.TWELVEDATA_API_KEY = 'test-key';
    const fetchMock = mockFetchJson({});
    const provider = new TwelveDataPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'gold', symbol: 'XAU', quoteCurrency: 'USD' },
      { assetClass: 'foreign_currency', symbol: 'USD', quoteCurrency: 'VND' },
    ]);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honours an explicit providerSymbol override', async () => {
    process.env.TWELVEDATA_API_KEY = 'test-key';
    const fetchMock = mockFetchJson({ 'VOO.US': { price: '500.00' } });
    const provider = new TwelveDataPriceProvider();

    const result = await provider.getLatestPrices([
      {
        assetClass: 'fund',
        symbol: 'VOO',
        providerSymbol: 'VOO.US',
        quoteCurrency: 'USD',
      },
    ]);

    const url = firstFetchUrl(fetchMock);
    expect(url.searchParams.get('symbol')).toBe('VOO.US');
    // The quote maps back to the position's own symbol, not the provider ticker.
    expect(result[0].symbol).toBe('VOO');
    expect(result[0].price).toBe(500);
  });
});

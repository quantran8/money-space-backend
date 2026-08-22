import { CoinMarketCapSymbolReferenceProvider } from './coinmarketcap-symbol-reference.provider';

describe('CoinMarketCapSymbolReferenceProvider', () => {
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

  const mapBody = {
    data: [
      { id: 1, symbol: 'BTC', name: 'Bitcoin', rank: 1 },
      { id: 1027, symbol: 'ETH', name: 'Ethereum', rank: 2 },
    ],
  };

  it('returns [] and never calls fetch without an API key', async () => {
    delete process.env.COIN_MARKETCAP_API_KEY;
    const fetchMock = mockFetchJson(mapBody);
    const provider = new CoinMarketCapSymbolReferenceProvider();

    expect(await provider.listSymbols('crypto')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps the coin listing to symbol references', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    mockFetchJson(mapBody);
    const provider = new CoinMarketCapSymbolReferenceProvider();

    const result = await provider.listSymbols('crypto');

    expect(result).toEqual([
      {
        assetClass: 'crypto',
        symbol: 'BTC',
        name: 'Bitcoin',
        exchange: '',
        currency: 'USD',
        unit: 'coin',
      },
      {
        assetClass: 'crypto',
        symbol: 'ETH',
        name: 'Ethereum',
        exchange: '',
        currency: 'USD',
        unit: 'coin',
      },
    ]);
  });

  it('never lists stocks — that class stays on another provider', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    const fetchMock = mockFetchJson(mapBody);
    const provider = new CoinMarketCapSymbolReferenceProvider();

    expect(await provider.listSymbols('stock')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('de-dupes repeated tickers, keeping the highest-ranked row', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    mockFetchJson({
      data: [
        { id: 7083, symbol: 'UNI', name: 'Uniswap', rank: 20 },
        { id: 9000, symbol: 'UNI', name: 'Unicorn Token', rank: 3000 },
      ],
    });
    const provider = new CoinMarketCapSymbolReferenceProvider();

    const result = await provider.listSymbols('crypto');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Uniswap');
  });

  it('caches the listing so a second call issues no request', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    const fetchMock = mockFetchJson(mapBody);
    const provider = new CoinMarketCapSymbolReferenceProvider();

    await provider.listSymbols('crypto');
    const second = await provider.listSymbols('crypto');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(2);
  });

  it('coalesces concurrent callers into a single request', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    const fetchMock = mockFetchJson(mapBody);
    const provider = new CoinMarketCapSymbolReferenceProvider();

    const [a, b] = await Promise.all([
      provider.listSymbols('crypto'),
      provider.listSymbols('crypto'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('returns [] on an upstream error instead of throwing', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    mockFetchJson({}, false, 500);
    const provider = new CoinMarketCapSymbolReferenceProvider();

    await expect(provider.listSymbols('crypto')).resolves.toEqual([]);
  });

  it('keeps the previous list when a later refresh fails', async () => {
    process.env.COIN_MARKETCAP_API_KEY = 'test-key';
    mockFetchJson(mapBody);
    const provider = new CoinMarketCapSymbolReferenceProvider();
    const first = await provider.listSymbols('crypto');
    expect(first).toHaveLength(2);

    // Expire the cache, then fail the refresh.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 48 * 60 * 60 * 1000);
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(provider.listSymbols('crypto')).resolves.toHaveLength(2);
  });
});

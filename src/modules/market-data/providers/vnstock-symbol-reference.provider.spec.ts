import { VnstockSymbolReferenceProvider } from './vnstock-symbol-reference.provider';

const search = jest.fn<unknown[], [string, { limit?: number }?]>();
const init = jest.fn<Promise<void>, []>();

jest.mock('vnstock-js', () => ({
  init: (): Promise<void> => init(),
  stock: {
    search: (query: string, options?: { limit?: number }): unknown[] =>
      search(query, options),
  },
}));

describe('VnstockSymbolReferenceProvider', () => {
  beforeEach(() => {
    search.mockReset();
    init.mockReset().mockResolvedValue(undefined);
  });

  const DIRECTORY = [
    {
      symbol: 'VNM',
      companyName: 'Công ty Cổ phần Sữa Việt Nam',
      companyNameEn: 'Vietnam Dairy Products JSC',
      exchange: 'HSX',
    },
    {
      symbol: 'SHS',
      companyName: 'Chứng khoán Sài Gòn - Hà Nội',
      companyNameEn: 'Saigon Hanoi Securities',
      exchange: 'HNX',
    },
    // Must be filtered out — nothing can price these.
    { symbol: 'CVNM2111', companyName: 'Chứng quyền', exchange: 'DELISTED' },
    { symbol: 'BAB124014', companyName: 'Trái phiếu', exchange: 'BOND' },
  ];

  it('lists only tradable HSX/HNX/UPCOM equities', async () => {
    search.mockReturnValue(DIRECTORY);
    const provider = new VnstockSymbolReferenceProvider();

    const result = await provider.listSymbols('stock');

    expect(result.map((r) => r.symbol)).toEqual(['VNM', 'SHS']);
    expect(result[0]).toEqual({
      assetClass: 'stock',
      symbol: 'VNM',
      // Vietnamese name wins in this Vietnamese-first app.
      name: 'Công ty Cổ phần Sữa Việt Nam',
      exchange: 'HSX',
      currency: 'VND',
      unit: 'cp',
    });
  });

  it('initialises the bundled directory exactly once', async () => {
    search.mockReturnValue(DIRECTORY);
    const provider = new VnstockSymbolReferenceProvider();

    await provider.listSymbols('stock');
    await provider.listSymbols('stock');

    expect(init).toHaveBeenCalledTimes(1);
  });

  it('caches the listing so a second call re-uses it', async () => {
    search.mockReturnValue(DIRECTORY);
    const provider = new VnstockSymbolReferenceProvider();

    await provider.listSymbols('stock');
    const second = await provider.listSymbols('stock');

    expect(search).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(2);
  });

  it('never lists crypto — that class stays on another provider', async () => {
    const provider = new VnstockSymbolReferenceProvider();

    expect(await provider.listSymbols('crypto')).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('returns [] on an upstream failure instead of throwing', async () => {
    search.mockImplementation(() => {
      throw new Error('directory unavailable');
    });
    const provider = new VnstockSymbolReferenceProvider();

    await expect(provider.listSymbols('stock')).resolves.toEqual([]);
  });

  it('keeps the previous list when a later refresh fails', async () => {
    search.mockReturnValue(DIRECTORY);
    const provider = new VnstockSymbolReferenceProvider();
    expect(await provider.listSymbols('stock')).toHaveLength(2);

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 48 * 60 * 60 * 1000);
    search.mockImplementation(() => {
      throw new Error('directory unavailable');
    });

    await expect(provider.listSymbols('stock')).resolves.toHaveLength(2);
    jest.restoreAllMocks();
  });

  it('de-dupes a symbol repeated across rows', async () => {
    search.mockReturnValue([
      { symbol: 'VNM', companyName: 'Vinamilk', exchange: 'HSX' },
      { symbol: 'VNM', companyName: 'Vinamilk (dup)', exchange: 'HSX' },
    ]);
    const provider = new VnstockSymbolReferenceProvider();

    const result = await provider.listSymbols('stock');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Vinamilk');
  });

  it('excludes covered warrants that trade on a real exchange', async () => {
    // `CVNM2511` is on HSX like a share, so the exchange filter alone lets it
    // through — and typing "VNM" then surfaces warrants above VNM itself.
    search.mockReturnValue([
      {
        symbol: 'VNM',
        companyName: 'Công ty Cổ phần Sữa Việt Nam',
        exchange: 'HSX',
      },
      {
        symbol: 'CVNM2511',
        companyName: 'CVNM2511 - Chứng quyền',
        companyNameEn: 'CVNM2511 - Covered warrant',
        exchange: 'HSX',
      },
    ]);
    const provider = new VnstockSymbolReferenceProvider();

    const result = await provider.listSymbols('stock');

    expect(result.map((r) => r.symbol)).toEqual(['VNM']);
  });
});

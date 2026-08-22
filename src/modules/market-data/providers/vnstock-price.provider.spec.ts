import { VnstockPriceProvider } from './vnstock-price.provider';
import type { SymbolRequest } from './symbol-request';

/** The batched call the provider makes; stubbed per test. */
const priceBoard = jest.fn<Promise<unknown[]>, [string[]]>();

jest.mock('vnstock-js', () => ({
  Vnstock: jest.fn().mockImplementation(() => ({
    stock: {
      trading: {
        priceBoard: (tickers: string[]): Promise<unknown[]> =>
          priceBoard(tickers),
      },
    },
  })),
}));

describe('VnstockPriceProvider', () => {
  beforeEach(() => {
    priceBoard.mockReset();
  });

  const VNM: SymbolRequest = {
    assetClass: 'stock',
    symbol: 'VNM',
    market: 'HOSE',
    quoteCurrency: 'VND',
  };

  it('scales quotes from thousands of VND to VND', async () => {
    // vnstock reports VNM at 63.8 for a 63,800đ share.
    priceBoard.mockResolvedValue([
      { symbol: 'VNM', price: 63.8, referencePrice: 64 },
    ]);
    const provider = new VnstockPriceProvider();

    const result = await provider.getLatestPrices([VNM]);

    expect(result).toEqual([
      expect.objectContaining({
        assetClass: 'stock',
        symbol: 'VNM',
        price: 63_800,
        quoteCurrency: 'VND',
        source: 'vnstock',
      }),
    ]);
  });

  it('batches the whole VN slice into one call', async () => {
    priceBoard.mockResolvedValue([
      { symbol: 'VNM', price: 63.8 },
      { symbol: 'FPT', price: 72 },
    ]);
    const provider = new VnstockPriceProvider();

    const result = await provider.getLatestPrices([
      VNM,
      { ...VNM, symbol: 'FPT' },
    ]);

    expect(priceBoard).toHaveBeenCalledTimes(1);
    expect(priceBoard).toHaveBeenCalledWith(['VNM', 'FPT']);
    expect(result.map((q) => q.price)).toEqual([63_800, 72_000]);
  });

  it('falls back to the reference price when a ticker has not traded', async () => {
    // Pre-open, or an illiquid UPCOM name: price is 0 but the reference stands.
    priceBoard.mockResolvedValue([
      { symbol: 'VNM', price: 0, referencePrice: 64 },
    ]);
    const provider = new VnstockPriceProvider();

    const result = await provider.getLatestPrices([VNM]);

    expect(result[0].price).toBe(64_000);
  });

  it('skips a ticker missing from the board but keeps the good quotes', async () => {
    priceBoard.mockResolvedValue([{ symbol: 'VNM', price: 63.8 }]);
    const provider = new VnstockPriceProvider();

    const result = await provider.getLatestPrices([
      VNM,
      { ...VNM, symbol: 'NOPE' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('VNM');
  });

  it('returns [] when the upstream call fails, never propagating it', async () => {
    priceBoard.mockRejectedValue(new Error('ECONNRESET'));
    const provider = new VnstockPriceProvider();

    await expect(provider.getLatestPrices([VNM])).resolves.toEqual([]);
  });

  it('ignores crypto and other non-equity classes', async () => {
    const provider = new VnstockPriceProvider();

    const result = await provider.getLatestPrices([
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'VND' },
      { assetClass: 'gold', symbol: 'XAU', quoteCurrency: 'VND' },
    ]);

    expect(result).toEqual([]);
    expect(priceBoard).not.toHaveBeenCalled();
  });

  it('ignores a position quoted in anything but VND', async () => {
    const provider = new VnstockPriceProvider();

    // A VN share is only quoted in VND; handing back a VND number labelled USD
    // would silently misstate the holding.
    const result = await provider.getLatestPrices([
      { ...VNM, quoteCurrency: 'USD' },
    ]);

    expect(result).toEqual([]);
    expect(priceBoard).not.toHaveBeenCalled();
  });

  it('honours an explicit providerSymbol override', async () => {
    priceBoard.mockResolvedValue([{ symbol: 'HPG', price: 21.7 }]);
    const provider = new VnstockPriceProvider();

    const result = await provider.getLatestPrices([
      { ...VNM, symbol: 'HPG-OLD', providerSymbol: 'HPG' },
    ]);

    expect(priceBoard).toHaveBeenCalledWith(['HPG']);
    // Maps back to the position's own symbol, not the provider ticker.
    expect(result[0]).toMatchObject({ symbol: 'HPG-OLD', price: 21_700 });
  });

  it('prices two positions sharing one ticker from a single board row', async () => {
    priceBoard.mockResolvedValue([{ symbol: 'VNM', price: 63.8 }]);
    const provider = new VnstockPriceProvider();

    const result = await provider.getLatestPrices([VNM, { ...VNM }]);

    expect(priceBoard).toHaveBeenCalledWith(['VNM']);
    expect(result).toHaveLength(2);
  });
});

describe('VnstockPriceProvider.isTradableExchange', () => {
  it.each(['HSX', 'HOSE', 'HNX', 'UPCOM', 'hnx'])('accepts %s', (exchange) => {
    expect(VnstockPriceProvider.isTradableExchange(exchange)).toBe(true);
  });

  it.each(['DELISTED', 'BOND', ''])('rejects %s', (exchange) => {
    expect(VnstockPriceProvider.isTradableExchange(exchange)).toBe(false);
  });
});

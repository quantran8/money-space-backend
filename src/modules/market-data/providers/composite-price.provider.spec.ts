import { CompositePriceProvider } from './composite-price.provider';
import type { AssetClass } from '../../assets/entities/asset.entity';
import type { MarketPrice } from '../entities/market-price.entity';
import type { PriceProvider } from './price-provider.interface';
import type { SymbolRequest } from './symbol-request';

/** Minimal stub that echoes back one quote per request it is handed. */
class StubProvider implements PriceProvider {
  readonly calls: SymbolRequest[][] = [];

  constructor(
    private readonly source: string,
    private readonly failure?: Error,
  ) {}

  getLatestPrices(requests: SymbolRequest[] = []): Promise<MarketPrice[]> {
    this.calls.push(requests);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(
      requests.map((r) => ({
        assetClass: r.assetClass,
        symbol: r.symbol,
        price: 1,
        unit: r.symbol,
        quoteCurrency: r.quoteCurrency,
        priceTime: '2026-01-01T00:00:00.000Z',
        source: this.source,
      })),
    );
  }
}

function routes(
  entries: Array<[AssetClass, PriceProvider]>,
): ReadonlyMap<AssetClass, PriceProvider> {
  return new Map(entries);
}

describe('CompositePriceProvider', () => {
  it('routes each class to its provider and merges the results', async () => {
    const equities = new StubProvider('twelvedata');
    const crypto = new StubProvider('coinmarketcap');
    const provider = new CompositePriceProvider(
      routes([
        ['stock', equities],
        ['fund', equities],
        ['crypto', crypto],
      ]),
    );

    const result = await provider.getLatestPrices([
      { assetClass: 'stock', symbol: 'AAPL', quoteCurrency: 'USD' },
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
      { assetClass: 'fund', symbol: 'VOO', quoteCurrency: 'USD' },
    ]);

    expect(result).toHaveLength(3);
    expect(result.find((q) => q.symbol === 'BTC')?.source).toBe(
      'coinmarketcap',
    );
    expect(result.find((q) => q.symbol === 'AAPL')?.source).toBe('twelvedata');
  });

  it('calls each delegate once with only its own slice', async () => {
    const equities = new StubProvider('twelvedata');
    const crypto = new StubProvider('coinmarketcap');
    const provider = new CompositePriceProvider(
      routes([
        ['stock', equities],
        ['fund', equities],
        ['crypto', crypto],
      ]),
    );

    await provider.getLatestPrices([
      { assetClass: 'stock', symbol: 'AAPL', quoteCurrency: 'USD' },
      { assetClass: 'fund', symbol: 'VOO', quoteCurrency: 'USD' },
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
    ]);

    // Batching is preserved: one call carrying both equity positions.
    expect(equities.calls).toHaveLength(1);
    expect(equities.calls[0].map((r) => r.symbol)).toEqual(['AAPL', 'VOO']);
    expect(crypto.calls).toHaveLength(1);
    expect(crypto.calls[0].map((r) => r.symbol)).toEqual(['BTC']);
  });

  it('drops requests whose class has no route', async () => {
    const crypto = new StubProvider('coinmarketcap');
    const provider = new CompositePriceProvider(routes([['crypto', crypto]]));

    const result = await provider.getLatestPrices([
      { assetClass: 'gold', symbol: 'XAU', quoteCurrency: 'USD' },
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
    ]);

    expect(result.map((q) => q.symbol)).toEqual(['BTC']);
  });

  it("keeps one provider's quotes when another throws", async () => {
    const equities = new StubProvider('twelvedata');
    const crypto = new StubProvider(
      'coinmarketcap',
      new Error('upstream down'),
    );
    const provider = new CompositePriceProvider(
      routes([
        ['stock', equities],
        ['crypto', crypto],
      ]),
    );

    const result = await provider.getLatestPrices([
      { assetClass: 'stock', symbol: 'AAPL', quoteCurrency: 'USD' },
      { assetClass: 'crypto', symbol: 'BTC', quoteCurrency: 'USD' },
    ]);

    expect(result.map((q) => q.symbol)).toEqual(['AAPL']);
  });

  it('returns [] with no requests and never calls a delegate', async () => {
    const crypto = new StubProvider('coinmarketcap');
    const provider = new CompositePriceProvider(routes([['crypto', crypto]]));

    expect(await provider.getLatestPrices([])).toEqual([]);
    expect(crypto.calls).toHaveLength(0);
  });

  it('sends an overridden position to its provider, not the class route', () => {
    const foreign = new StubProvider('twelvedata');
    const vn = new StubProvider('vnstock');
    const provider = new CompositePriceProvider(routes([['stock', foreign]]), [
      { matches: (r) => r.market === 'HOSE', provider: vn },
    ]);

    return provider
      .getLatestPrices([
        {
          assetClass: 'stock',
          symbol: 'FPT',
          market: 'HOSE',
          quoteCurrency: 'VND',
        },
        {
          assetClass: 'stock',
          symbol: 'AAPL',
          market: 'NASDAQ',
          quoteCurrency: 'USD',
        },
      ])
      .then((result) => {
        expect(result.find((q) => q.symbol === 'FPT')?.source).toBe('vnstock');
        expect(result.find((q) => q.symbol === 'AAPL')?.source).toBe(
          'twelvedata',
        );
        // Each upstream still gets exactly one batched call.
        expect(vn.calls).toEqual([
          [expect.objectContaining({ symbol: 'FPT' })],
        ]);
        expect(foreign.calls).toEqual([
          [expect.objectContaining({ symbol: 'AAPL' })],
        ]);
      });
  });

  it('routes an overridden position even when its class has no route', async () => {
    const vn = new StubProvider('vnstock');
    const provider = new CompositePriceProvider(routes([]), [
      { matches: (r) => r.market === 'HOSE', provider: vn },
    ]);

    const result = await provider.getLatestPrices([
      {
        assetClass: 'stock',
        symbol: 'FPT',
        market: 'HOSE',
        quoteCurrency: 'VND',
      },
    ]);

    expect(result.map((q) => q.source)).toEqual(['vnstock']);
  });

  it('uses the first matching override', async () => {
    const first = new StubProvider('first');
    const second = new StubProvider('second');
    const provider = new CompositePriceProvider(routes([]), [
      { matches: () => true, provider: first },
      { matches: () => true, provider: second },
    ]);

    const result = await provider.getLatestPrices([
      { assetClass: 'stock', symbol: 'FPT', quoteCurrency: 'VND' },
    ]);

    expect(result.map((q) => q.source)).toEqual(['first']);
    expect(second.calls).toHaveLength(0);
  });
});

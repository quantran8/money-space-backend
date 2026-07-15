import { MarketDataService } from './market-data.service';
import type { MarketDataRepository } from './repositories/market-data.repository.interface';
import type { PriceProvider } from './providers/price-provider.interface';
import type { SymbolReferenceProvider } from './providers/symbol-reference-provider.interface';
import type { SymbolReference } from './entities/symbol-reference.entity';

function buildService(reference: SymbolReference[]) {
  const repository = {
    getFxRates: jest.fn().mockResolvedValue([]),
    getMarketSymbolUniverse: jest.fn().mockResolvedValue([]),
  } as unknown as MarketDataRepository;
  const priceProvider = {
    getLatestPrices: jest.fn().mockResolvedValue([]),
  } as unknown as PriceProvider;
  const symbolReferenceProvider: SymbolReferenceProvider = {
    listSymbols: (): Promise<SymbolReference[]> => Promise.resolve(reference),
  };
  return new MarketDataService(
    repository,
    priceProvider,
    symbolReferenceProvider,
  );
}

const APPLE: SymbolReference = {
  assetClass: 'stock',
  symbol: 'AAPL',
  name: 'Apple Inc',
  exchange: 'NASDAQ',
  currency: 'USD',
  unit: 'cp',
};
const APP: SymbolReference = {
  assetClass: 'stock',
  symbol: 'APP',
  name: 'AppLovin Corp',
  exchange: 'NASDAQ',
  currency: 'USD',
  unit: 'cp',
};
const MSFT: SymbolReference = {
  assetClass: 'stock',
  symbol: 'MSFT',
  name: 'Microsoft Corp',
  exchange: 'NASDAQ',
  currency: 'USD',
  unit: 'cp',
};

describe('MarketDataService.searchSymbols', () => {
  it('returns the curated default list (no query) when reference data is empty', async () => {
    const service = buildService([]);
    const result = await service.searchSymbols({ assetClass: 'crypto' });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].symbol).toBe('BTC');
    expect(result.query).toBe('');
  });

  it('upgrades curated defaults with live reference details when available', async () => {
    const service = buildService([
      { ...APPLE, name: 'Apple Inc. (live)', exchange: 'XNAS' },
    ]);
    const result = await service.searchSymbols({ assetClass: 'stock' });
    const aapl = result.items.find((i) => i.symbol === 'AAPL');
    expect(aapl?.name).toBe('Apple Inc. (live)');
    expect(aapl?.exchange).toBe('XNAS');
  });

  it('ranks exact ticker > prefix > substring > name match', async () => {
    const NPAAP: SymbolReference = {
      assetClass: 'stock',
      symbol: 'ZZZ',
      name: 'App Holdings',
      exchange: 'NYSE',
      currency: 'USD',
      unit: 'cp',
    };
    const service = buildService([APP, APPLE, MSFT, NPAAP]);
    const result = await service.searchSymbols({
      assetClass: 'stock',
      q: 'app',
    });
    // APP (exact) first, AAPL (ticker substring) before ZZZ (name-only match);
    // MSFT (no match) excluded.
    expect(result.items.map((i) => i.symbol)).toEqual(['APP', 'AAPL', 'ZZZ']);
  });

  it('filters the curated fallback when reference data is unavailable', async () => {
    const service = buildService([]);
    const result = await service.searchSymbols({
      assetClass: 'crypto',
      q: 'eth',
    });
    // ETH is an exact ticker match; USDT ("t-ETH-er") is a name-substring match,
    // so it ranks after ETH but is still a legitimate hit.
    expect(result.items[0].symbol).toBe('ETH');
    expect(result.items.map((i) => i.symbol)).toContain('USDT');
  });

  it('returns empty for an unsupported / missing asset class', async () => {
    const service = buildService([]);
    const result = await service.searchSymbols({ q: 'btc' });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('caps the limit', async () => {
    const many: SymbolReference[] = Array.from({ length: 80 }, (_, i) => ({
      assetClass: 'stock' as const,
      symbol: `SYM${i}`,
      name: `Company ${i}`,
      exchange: 'NYSE',
      currency: 'USD',
      unit: 'cp',
    }));
    const service = buildService(many);
    const result = await service.searchSymbols({
      assetClass: 'stock',
      q: 'SYM',
      limit: '999',
    });
    expect(result.items.length).toBeLessThanOrEqual(50);
  });
});

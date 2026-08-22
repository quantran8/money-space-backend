import { CompositeSymbolReferenceProvider } from './composite-symbol-reference.provider';
import type { SymbolReference } from '../entities/symbol-reference.entity';
import type {
  SymbolAssetClass,
  SymbolReferenceProvider,
} from './symbol-reference-provider.interface';

class StubProvider implements SymbolReferenceProvider {
  calls = 0;

  constructor(
    private readonly items: SymbolReference[],
    private readonly failure?: Error,
  ) {}

  listSymbols(): Promise<SymbolReference[]> {
    this.calls += 1;
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.items);
  }
}

function ref(symbol: string, name = symbol): SymbolReference {
  return {
    assetClass: 'stock',
    symbol,
    name,
    exchange: 'HSX',
    currency: 'VND',
    unit: 'cp',
  };
}

function routes(
  entries: Array<[SymbolAssetClass, SymbolReferenceProvider[]]>,
): ReadonlyMap<SymbolAssetClass, readonly SymbolReferenceProvider[]> {
  return new Map(entries);
}

describe('CompositeSymbolReferenceProvider', () => {
  it('returns [] for a class with no route', async () => {
    const provider = new CompositeSymbolReferenceProvider(routes([]));
    expect(await provider.listSymbols('stock')).toEqual([]);
  });

  it('merges several sources in route order', async () => {
    const vn = new StubProvider([ref('VNM'), ref('FPT')]);
    const foreign = new StubProvider([ref('AAPL')]);
    const provider = new CompositeSymbolReferenceProvider(
      routes([['stock', [vn, foreign]]]),
    );

    const result = await provider.listSymbols('stock');

    // VN listings lead — order encodes precedence.
    expect(result.map((r) => r.symbol)).toEqual(['VNM', 'FPT', 'AAPL']);
  });

  it('de-dupes across sources, first source winning', async () => {
    const vn = new StubProvider([ref('VNM', 'Vinamilk (VN)')]);
    const foreign = new StubProvider([ref('VNM', 'Vinamilk (foreign)')]);
    const provider = new CompositeSymbolReferenceProvider(
      routes([['stock', [vn, foreign]]]),
    );

    const result = await provider.listSymbols('stock');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Vinamilk (VN)');
  });

  it('keeps the surviving sources when one throws', async () => {
    const failing = new StubProvider([], new Error('upstream down'));
    const ok = new StubProvider([ref('VNM')]);
    const provider = new CompositeSymbolReferenceProvider(
      routes([['stock', [failing, ok]]]),
    );

    const result = await provider.listSymbols('stock');

    expect(result.map((r) => r.symbol)).toEqual(['VNM']);
  });

  it('returns [] when every source fails, letting the caller fall back', async () => {
    const a = new StubProvider([], new Error('down'));
    const b = new StubProvider([], new Error('down'));
    const provider = new CompositeSymbolReferenceProvider(
      routes([['stock', [a, b]]]),
    );

    await expect(provider.listSymbols('stock')).resolves.toEqual([]);
  });

  it('only queries the requested class', async () => {
    const stock = new StubProvider([ref('VNM')]);
    const crypto = new StubProvider([]);
    const provider = new CompositeSymbolReferenceProvider(
      routes([
        ['stock', [stock]],
        ['crypto', [crypto]],
      ]),
    );

    await provider.listSymbols('stock');

    expect(stock.calls).toBe(1);
    expect(crypto.calls).toBe(0);
  });
});

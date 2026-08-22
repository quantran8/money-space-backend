import { Injectable, Logger } from '@nestjs/common';
import type { SymbolReference } from '../entities/symbol-reference.entity';
import type {
  SymbolAssetClass,
  SymbolReferenceProvider,
} from './symbol-reference-provider.interface';

/**
 * Routes each searchable class to the providers that list it. Mirrors
 * `CompositePriceProvider` so quotes and reference data are swapped as a pair.
 *
 * A class may have **several** sources — `stock` is both Vietnamese (vnstock)
 * and foreign (Twelve Data) listings — so results are concatenated in route
 * order and de-duplicated by symbol, first source winning. Order therefore
 * encodes precedence: VN listings lead the picker in this Vietnamese-first app.
 *
 * A delegate that throws is logged and contributes nothing; the remaining
 * sources still produce a list, and if all fail the service falls back to the
 * curated defaults rather than surfacing an error.
 */
@Injectable()
export class CompositeSymbolReferenceProvider implements SymbolReferenceProvider {
  private readonly logger = new Logger(CompositeSymbolReferenceProvider.name);

  constructor(
    private readonly routes: ReadonlyMap<
      SymbolAssetClass,
      readonly SymbolReferenceProvider[]
    >,
  ) {}

  async listSymbols(assetClass: SymbolAssetClass): Promise<SymbolReference[]> {
    const providers = this.routes.get(assetClass);
    if (!providers || providers.length === 0) return [];

    const lists = await Promise.all(
      providers.map(async (provider) => {
        try {
          return await provider.listSymbols(assetClass);
        } catch (error) {
          this.logger.error(
            `${provider.constructor.name} failed for ${assetClass}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return [];
        }
      }),
    );

    const seen = new Set<string>();
    const merged: SymbolReference[] = [];
    for (const list of lists) {
      for (const entry of list) {
        const key = entry.symbol.trim().toUpperCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(entry);
      }
    }
    return merged;
  }
}

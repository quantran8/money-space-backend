import { Injectable, Logger } from '@nestjs/common';
import type { AssetClass } from '../../assets/entities/asset.entity';
import type { MarketPrice } from '../entities/market-price.entity';
import type { PriceProvider } from './price-provider.interface';
import type { SymbolRequest } from './symbol-request';

/** A route that claims individual positions rather than a whole asset class. */
export interface PriceOverride {
  matches: (request: SymbolRequest) => boolean;
  provider: PriceProvider;
}

/**
 * Routes each position to its provider and merges the results; callers see one
 * `PriceProvider`. Overrides win over the class map. Each delegate is called
 * once with its own slice, so per-adapter batching is preserved, and one
 * failing upstream never blanks out the others.
 */
@Injectable()
export class CompositePriceProvider implements PriceProvider {
  private readonly logger = new Logger(CompositePriceProvider.name);

  constructor(
    /** Per-class delegate; classes with no route are simply not priced. */
    private readonly routes: ReadonlyMap<AssetClass, PriceProvider>,
    /** Checked before `routes`; first match wins. */
    private readonly overrides: readonly PriceOverride[] = [],
  ) {}

  async getLatestPrices(
    requests: SymbolRequest[] = [],
  ): Promise<MarketPrice[]> {
    if (requests.length === 0) return [];

    // Group by delegate so each upstream still gets one batched call.
    const byProvider = new Map<PriceProvider, SymbolRequest[]>();
    for (const request of requests) {
      const provider = this.resolve(request);
      if (!provider) continue;
      const group = byProvider.get(provider);
      if (group) group.push(request);
      else byProvider.set(provider, [request]);
    }
    if (byProvider.size === 0) return [];

    const settled = await Promise.all(
      [...byProvider].map(async ([provider, group]) => {
        try {
          return await provider.getLatestPrices(group);
        } catch (error) {
          this.logger.error(
            `${provider.constructor.name} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return [];
        }
      }),
    );
    return settled.flat();
  }

  private resolve(request: SymbolRequest): PriceProvider | undefined {
    for (const override of this.overrides) {
      if (override.matches(request)) return override.provider;
    }
    return this.routes.get(request.assetClass);
  }
}

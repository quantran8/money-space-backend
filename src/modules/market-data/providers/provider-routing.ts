import type { AssetClass } from '../../assets/entities/asset.entity';
import type { PriceProvider } from './price-provider.interface';
import type { SymbolRequest } from './symbol-request';
import type {
  SymbolAssetClass,
  SymbolReferenceProvider,
} from './symbol-reference-provider.interface';

/** Classes Twelve Data quotes when it is the one serving them. */
const TWELVE_DATA_CLASSES: AssetClass[] = ['stock', 'fund', 'crypto'];

/** Classes the commodity feed quotes; it needs no key, so they always route. */
const COMMODITY_CLASSES: AssetClass[] = ['gold', 'foreign_currency'];

/** Venues that identify a Vietnamese listing. */
const VN_MARKETS: ReadonlySet<string> = new Set([
  'HOSE',
  'HSX',
  'HNX',
  'UPCOM',
  'VN',
]);

/** Which upstream keys are configured. Read from `process.env` by the module. */
export interface ProviderKeys {
  twelveData?: string;
  coinMarketCap?: string;
}

/** VN equity? Decided by venue, else by a VND quote — never by symbol shape. */
export function isVietnameseEquity(request: SymbolRequest): boolean {
  const market = request.market?.trim().toUpperCase();
  if (market) return VN_MARKETS.has(market);
  return (request.quoteCurrency || '').toUpperCase() === 'VND';
}

/**
 * Per-class quote routing; a class whose provider has no key stays unrouted.
 * Kept out of the module so it is testable without booting the DI container.
 */
export function priceRoutes(
  keys: ProviderKeys,
  providers: {
    twelveData: PriceProvider;
    coinMarketCap: PriceProvider;
    commodity: PriceProvider;
  },
): Map<AssetClass, PriceProvider> {
  const routes = new Map<AssetClass, PriceProvider>();
  if (keys.twelveData) {
    for (const assetClass of TWELVE_DATA_CLASSES) {
      routes.set(assetClass, providers.twelveData);
    }
  }
  // Set last so it wins the crypto slot over Twelve Data.
  if (keys.coinMarketCap) routes.set('crypto', providers.coinMarketCap);
  // Gold and FX come from the dealer/bank feed, which needs no key — so, like
  // the reference-data routes below, these are always present. Without them the
  // composite dropped both classes and the valuation engine never saw a quote.
  for (const assetClass of COMMODITY_CLASSES) {
    routes.set(assetClass, providers.commodity);
  }
  return routes;
}

/** Per-position routes, checked before the class map (VN vs foreign equities). */
export function priceOverrides(providers: { vnstock: PriceProvider }): Array<{
  matches: (request: SymbolRequest) => boolean;
  provider: PriceProvider;
}> {
  return [
    {
      matches: (request) =>
        (request.assetClass === 'stock' || request.assetClass === 'fund') &&
        isVietnameseEquity(request),
      provider: providers.vnstock,
    },
  ];
}

/** Reference-data routing, mirroring `priceRoutes` so the pair stays in step. */
export function symbolReferenceRoutes(
  keys: ProviderKeys,
  providers: {
    twelveData: SymbolReferenceProvider;
    coinMarketCap: SymbolReferenceProvider;
    vnstock: SymbolReferenceProvider;
    commodity: SymbolReferenceProvider;
  },
): Map<SymbolAssetClass, SymbolReferenceProvider[]> {
  const routes = new Map<SymbolAssetClass, SymbolReferenceProvider[]>();
  // VN listings lead the stock picker.
  const stock: SymbolReferenceProvider[] = [providers.vnstock];
  if (keys.twelveData) stock.push(providers.twelveData);
  routes.set('stock', stock);

  const crypto: SymbolReferenceProvider[] = [];
  if (keys.coinMarketCap) crypto.push(providers.coinMarketCap);
  else if (keys.twelveData) crypto.push(providers.twelveData);
  if (crypto.length > 0) routes.set('crypto', crypto);

  // Gold/FX lists come from the commodity feed, which needs no key.
  routes.set('gold', [providers.commodity]);
  routes.set('foreign_currency', [providers.commodity]);

  return routes;
}

/** The keys as configured in the environment. */
export function providerKeysFromEnv(): ProviderKeys {
  return {
    twelveData: process.env.TWELVEDATA_API_KEY,
    coinMarketCap: process.env.COIN_MARKETCAP_API_KEY,
  };
}

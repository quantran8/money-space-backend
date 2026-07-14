import type { MarketPrice } from '../entities/market-price.entity';

export const PRICE_PROVIDER = Symbol('PRICE_PROVIDER');

/** External quote source. A real adapter should batch all supported symbols. */
export interface PriceProvider {
  getLatestPrices(): Promise<MarketPrice[]>;
}

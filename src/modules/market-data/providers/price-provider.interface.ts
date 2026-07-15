import type { MarketPrice } from '../entities/market-price.entity';
import type { SymbolRequest } from './symbol-request';

export const PRICE_PROVIDER = Symbol('PRICE_PROVIDER');

/**
 * External quote source. The adapter is told which symbols to price (the
 * distinct market-position universe) and should batch them into as few upstream
 * calls as possible. Returning fewer quotes than requested is allowed — an
 * unpriced symbol simply falls back to its last/cost price downstream.
 */
export interface PriceProvider {
  getLatestPrices(requests?: SymbolRequest[]): Promise<MarketPrice[]>;
}

import { Injectable } from '@nestjs/common';
import type { MarketPrice } from '../entities/market-price.entity';
import type { PriceProvider } from './price-provider.interface';

/** Default until a real provider adapter is configured. */
@Injectable()
export class NoopPriceProvider implements PriceProvider {
  async getLatestPrices(): Promise<MarketPrice[]> {
    return [];
  }
}

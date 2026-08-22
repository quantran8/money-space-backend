import { Injectable } from '@nestjs/common';
import type { FxCounterRate } from '../entities/fx-rate.entity';
import type { GoldPrice } from '../entities/gold-price.entity';
import type { CommodityProvider } from './commodity-provider.interface';

/** Default when no commodity adapter is configured. */
@Injectable()
export class NoopCommodityProvider implements CommodityProvider {
  getGoldPrices(): Promise<GoldPrice[]> {
    return Promise.resolve([]);
  }

  getFxCounterRates(): Promise<FxCounterRate[]> {
    return Promise.resolve([]);
  }
}

import type { FxCounterRate } from '../entities/fx-rate.entity';
import type { GoldPrice } from '../entities/gold-price.entity';

export const COMMODITY_PROVIDER = Symbol('COMMODITY_PROVIDER');

/**
 * Live gold and bank counter-rate quotes.
 *
 * Kept separate from `PriceProvider` because the shape genuinely differs: these
 * are dealer/bank quotes with a buy/sell spread, not a single mid price for a
 * position the household holds a quantity of. Same adapter boundary though, so
 * the upstream can be swapped without touching the service.
 *
 * Both methods return `[]` rather than throwing when the upstream is
 * unavailable — a gold outage must not fail a request.
 */
export interface CommodityProvider {
  /** Gold products quoted by Vietnamese dealers, VND per lượng. */
  getGoldPrices(): Promise<GoldPrice[]>;
  /** Bank counter rates against VND. */
  getFxCounterRates(): Promise<FxCounterRate[]>;
}

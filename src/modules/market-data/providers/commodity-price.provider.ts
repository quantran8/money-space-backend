import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '../../../common/cache/cache.service';
import { cacheKeys, cacheTtl } from '../../../common/cache/cache.keys';
import type { MarketPrice } from '../entities/market-price.entity';
import { GOLD_QUOTE_UNIT, goldPricesByUnit } from '../gold-units';
import { COMMODITY_PROVIDER } from './commodity-provider.interface';
import type { CommodityProvider } from './commodity-provider.interface';
import type { PriceProvider } from './price-provider.interface';
import type { SymbolRequest } from './symbol-request';

/**
 * Gold and foreign currency as a batched {@link PriceProvider}.
 *
 * These two classes are quoted by the commodity feed, not by the instrument
 * providers — they have no ticker to look up. `MarketDataService.getQuote`
 * already reached that feed for the symbol picker, but the valuation engine
 * reads the batched `getMarketPrices()` universe instead, which had no route
 * for them at all: every gold and FX holding fell through to its stored
 * `purchasePrice` and never moved. This adapter puts the same feed behind the
 * batched interface so `computeCurrentValue` prices them live.
 *
 * One upstream list per class serves the whole batch, and both lists share the
 * cache entries the gold/FX endpoints already fill, so a quote and a valuation
 * can never disagree about the price. Like the feed itself this never throws —
 * an unpriced symbol simply falls back downstream.
 */
@Injectable()
export class CommodityPriceProvider implements PriceProvider {
  constructor(
    @Inject(COMMODITY_PROVIDER)
    private readonly commodityProvider: CommodityProvider,
    private readonly cache: CacheService,
  ) {}

  async getLatestPrices(
    requests: SymbolRequest[] = [],
  ): Promise<MarketPrice[]> {
    const gold = requests.filter((request) => request.assetClass === 'gold');
    const fx = requests.filter(
      (request) => request.assetClass === 'foreign_currency',
    );
    const [goldPrices, fxPrices] = await Promise.all([
      gold.length > 0 ? this.goldPrices(gold) : [],
      fx.length > 0 ? this.fxPrices(fx) : [],
    ]);
    return [...goldPrices, ...fxPrices];
  }

  /**
   * Dealer gold quotes, on the **sell** side — what the household would pay to
   * acquire the holding, matching `MarketDataService.commodityQuote`. Falls back
   * to the buy side for a product the dealer does not sell.
   *
   * Priced in VND per lượng, the unit dealers publish. `computeCurrentValue`
   * restates that into the position's own unit via `priceInPositionUnit`, which
   * keys off `unit` — so it must stay {@link GOLD_QUOTE_UNIT} here.
   */
  private async goldPrices(requests: SymbolRequest[]): Promise<MarketPrice[]> {
    const prices = await this.cache.wrap(
      cacheKeys.goldPrices(),
      () => this.commodityProvider.getGoldPrices(),
      cacheTtl.commodity,
    );
    const quotes: MarketPrice[] = [];
    for (const request of requests) {
      const symbol = request.symbol.trim().toUpperCase();
      const match = prices.find(
        (price) => price.name.trim().toUpperCase() === symbol,
      );
      const price = match?.sellPrice ?? match?.buyPrice;
      if (!match || !price) continue;
      quotes.push({
        assetClass: 'gold',
        // The position's own spelling, since quotes are matched back by symbol.
        symbol: request.symbol,
        price,
        unit: GOLD_QUOTE_UNIT,
        unitPrices: goldPricesByUnit(price),
        quoteCurrency: 'VND',
        priceTime: match.priceTime || new Date().toISOString(),
        source: match.source,
      });
    }
    return quotes;
  }

  /** Bank counter rates, sell side first — VND per one unit of the currency. */
  private async fxPrices(requests: SymbolRequest[]): Promise<MarketPrice[]> {
    const rates = await this.cache.wrap(
      cacheKeys.fxCounterRates(),
      () => this.commodityProvider.getFxCounterRates(),
      cacheTtl.commodity,
    );
    const priceTime = new Date().toISOString();
    const quotes: MarketPrice[] = [];
    for (const request of requests) {
      const symbol = request.symbol.trim().toUpperCase();
      const match = rates.find((rate) => rate.currencyCode === symbol);
      const price = match?.sell ?? match?.buyTransfer ?? match?.buyCash;
      if (!match || !price) continue;
      quotes.push({
        assetClass: 'foreign_currency',
        symbol: request.symbol,
        price,
        unit: match.currencyCode,
        quoteCurrency: 'VND',
        priceTime,
        source: match.source,
      });
    }
    return quotes;
  }
}

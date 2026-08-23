import { Controller, Get, Query } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import type { ListFxRatesQuery } from './dto/list-fx-rates.query';
import type { ListFxCounterRatesQuery } from './dto/list-fx-counter-rates.query';
import type { ListGoldPricesQuery } from './dto/list-gold-prices.query';
import type { GetQuoteQuery } from './dto/get-quote.query';
import type { ListMarketPricesQuery } from './dto/list-market-prices.query';
import type { SearchSymbolsQuery } from './dto/search-symbols.query';

@Controller('market-data')
export class MarketDataController {
  constructor(private readonly marketDataService: MarketDataService) {}

  @Get('prices')
  listMarketPrices(@Query() query: ListMarketPricesQuery) {
    return this.marketDataService.listMarketPrices(query);
  }

  /**
   * Symbol picker for asset creation. `GET /api/v1/market-data/symbols?assetClass=
   * stock|crypto&q=<query>&limit=<n>`. Empty `q` → curated default list.
   */
  @Get('symbols')
  searchSymbols(@Query() query: SearchSymbolsQuery) {
    return this.marketDataService.searchSymbols(query);
  }

  @Get('fx-rates')
  listFxRates(@Query() query: ListFxRatesQuery) {
    return this.marketDataService.listFxRates(query);
  }

  /**
   * Price one instrument on demand, for the asset-create flow.
   * `GET /api/v1/market-data/quote?assetClass=stock&symbol=VNM&market=HOSE`.
   *
   * Returns `{ quote: MarketPrice | null }` — `null` when the symbol cannot be
   * priced, so the client falls back to a typed price instead of failing.
   */
  @Get('quote')
  async getQuote(@Query() query: GetQuoteQuery) {
    return { quote: await this.marketDataService.getQuote(query) };
  }

  /**
   * Live Vietnamese dealer gold quotes, VND per lượng.
   * `GET /api/v1/market-data/gold-prices?brand=SJC`.
   */
  @Get('gold-prices')
  listGoldPrices(@Query() query: ListGoldPricesQuery) {
    return this.marketDataService.listGoldPrices(query);
  }

  /**
   * Live bank counter rates against VND (buy cash / buy transfer / sell).
   * `GET /api/v1/market-data/fx-counter-rates?currencyCode=USD`.
   *
   * Separate from `fx-rates`, which serves the persisted reference rate.
   */
  @Get('fx-counter-rates')
  listFxCounterRates(@Query() query: ListFxCounterRatesQuery) {
    return this.marketDataService.listFxCounterRates(query);
  }
}

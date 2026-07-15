import { Controller, Get, Query } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import type { ListFxRatesQuery } from './dto/list-fx-rates.query';
import type { ListMarketPricesQuery } from './dto/list-market-prices.query';
import type { SearchSymbolsQuery } from './dto/search-symbols.query';

@Controller('api/market-data')
export class MarketDataController {
  constructor(private readonly marketDataService: MarketDataService) {}

  @Get('prices')
  listMarketPrices(@Query() query: ListMarketPricesQuery) {
    return this.marketDataService.listMarketPrices(query);
  }

  /**
   * Symbol picker for asset creation. `GET /api/market-data/symbols?assetClass=
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
}

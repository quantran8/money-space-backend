import { Inject, Injectable } from '@nestjs/common';
import { MARKET_DATA_AS_OF } from '../../common/seed/money-space.seed';
import type { ListFxRatesQuery } from './dto/list-fx-rates.query';
import type { ListMarketPricesQuery } from './dto/list-market-prices.query';
import { MARKET_DATA_REPOSITORY } from './repositories/market-data.repository.interface';
import type { MarketDataRepository } from './repositories/market-data.repository.interface';
import type { MarketPrice } from './entities/market-price.entity';
import { PRICE_PROVIDER } from './providers/price-provider.interface';
import type { PriceProvider } from './providers/price-provider.interface';
import { SYMBOL_REFERENCE_PROVIDER } from './providers/symbol-reference-provider.interface';
import type {
  SymbolAssetClass,
  SymbolReferenceProvider,
} from './providers/symbol-reference-provider.interface';
import type { SymbolReference } from './entities/symbol-reference.entity';
import type { SearchSymbolsQuery } from './dto/search-symbols.query';
import { DEFAULT_SYMBOLS } from './providers/default-symbols';

const SEARCHABLE_CLASSES: SymbolAssetClass[] = ['stock', 'crypto'];
const DEFAULT_SYMBOL_LIMIT = 20;
const MAX_SYMBOL_LIMIT = 50;

@Injectable()
export class MarketDataService {
  constructor(
    @Inject(MARKET_DATA_REPOSITORY)
    private readonly marketDataRepository: MarketDataRepository,
    @Inject(PRICE_PROVIDER)
    private readonly priceProvider: PriceProvider,
    @Inject(SYMBOL_REFERENCE_PROVIDER)
    private readonly symbolReferenceProvider: SymbolReferenceProvider,
  ) {}

  private cachedPrices: MarketPrice[] = [];
  private pricesExpireAt = 0;
  private pricesInFlight?: Promise<MarketPrice[]>;

  /** Latest provider quotes with a short-lived process cache; nothing is persisted. */
  async getMarketPrices(forceRefresh = false): Promise<MarketPrice[]> {
    const now = Date.now();
    if (!forceRefresh && now < this.pricesExpireAt) return this.cachedPrices;
    if (this.pricesInFlight) return this.pricesInFlight;
    const ttl = Number(process.env.MARKET_PRICE_CACHE_TTL_MS ?? 300_000);
    this.pricesInFlight = this.marketDataRepository
      .getMarketSymbolUniverse()
      .then((universe) => this.priceProvider.getLatestPrices(universe))
      .then((prices) => {
        this.cachedPrices = prices;
        this.pricesExpireAt =
          Date.now() + (Number.isFinite(ttl) ? ttl : 300_000);
        return prices;
      })
      .catch((error) => {
        if (this.cachedPrices.length > 0) return this.cachedPrices;
        throw error;
      })
      .finally(() => {
        this.pricesInFlight = undefined;
      });
    return this.pricesInFlight;
  }

  async listMarketPrices(query: ListMarketPricesQuery) {
    let items = [...(await this.getMarketPrices())];
    if (query.assetClass) {
      items = items.filter((price) => price.assetClass === query.assetClass);
    }
    if (query.symbol) {
      items = items.filter(
        (price) => price.symbol.toUpperCase() === query.symbol?.toUpperCase(),
      );
    }

    return {
      asOf: MARKET_DATA_AS_OF,
      items,
      total: items.length,
    };
  }

  async listFxRates(query: ListFxRatesQuery) {
    let items = [...(await this.marketDataRepository.getFxRates())];
    if (query.baseCurrency) {
      items = items.filter(
        (rate) =>
          rate.baseCurrency.toUpperCase() === query.baseCurrency?.toUpperCase(),
      );
    }
    if (query.quoteCurrency) {
      items = items.filter(
        (rate) =>
          rate.quoteCurrency.toUpperCase() ===
          query.quoteCurrency?.toUpperCase(),
      );
    }

    return {
      asOf: MARKET_DATA_AS_OF,
      items,
      total: items.length,
    };
  }

  /**
   * Symbol picker for the asset-create flow (stock / crypto). With no query it
   * returns the curated default list; with a query it ranks reference matches by
   * ticker/name. Reference data comes from the cached provider; when it is
   * unavailable (no API key / upstream down) the default list still works from
   * the curated fallback, and a typed query then filters that fallback.
   */
  async searchSymbols(query: SearchSymbolsQuery): Promise<{
    assetClass: SymbolAssetClass | null;
    query: string;
    items: SymbolReference[];
    total: number;
  }> {
    const assetClass = query.assetClass;
    if (!assetClass || !SEARCHABLE_CLASSES.includes(assetClass)) {
      return {
        assetClass: assetClass ?? null,
        query: query.q ?? '',
        items: [],
        total: 0,
      };
    }

    const limit = this.clampLimit(query.limit);
    const term = (query.q ?? '').trim();
    const reference =
      await this.symbolReferenceProvider.listSymbols(assetClass);

    const items = term
      ? this.rankMatches(this.pool(assetClass, reference), term, limit)
      : this.defaultList(assetClass, reference, limit);

    return { assetClass, query: term, items, total: items.length };
  }

  /** Reference list if available, otherwise the curated fallback for the class. */
  private pool(
    assetClass: SymbolAssetClass,
    reference: SymbolReference[],
  ): SymbolReference[] {
    return reference.length > 0 ? reference : DEFAULT_SYMBOLS[assetClass];
  }

  /**
   * The curated popular list, each entry upgraded with live reference details
   * (name/exchange/currency) when a match exists — so defaults stay accurate —
   * falling back to the curated entry. If reference data is missing entirely we
   * return the curated list as-is.
   */
  private defaultList(
    assetClass: SymbolAssetClass,
    reference: SymbolReference[],
    limit: number,
  ): SymbolReference[] {
    const curated = DEFAULT_SYMBOLS[assetClass];
    if (reference.length === 0) return curated.slice(0, limit);
    const bySymbol = new Map(
      reference.map((entry) => [entry.symbol.toUpperCase(), entry]),
    );
    return curated
      .map((entry) => bySymbol.get(entry.symbol.toUpperCase()) ?? entry)
      .slice(0, limit);
  }

  /**
   * Rank matches for a typed query: exact ticker first, then ticker prefix, then
   * ticker substring, then name substring; alphabetical within a tier.
   */
  private rankMatches(
    pool: SymbolReference[],
    term: string,
    limit: number,
  ): SymbolReference[] {
    const q = term.toUpperCase();
    const scored: Array<{ item: SymbolReference; score: number }> = [];
    for (const item of pool) {
      const symbol = item.symbol.toUpperCase();
      const name = item.name.toUpperCase();
      let score = 0;
      if (symbol === q) score = 4;
      else if (symbol.startsWith(q)) score = 3;
      else if (symbol.includes(q)) score = 2;
      else if (name.includes(q)) score = 1;
      if (score > 0) scored.push({ item, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.item.symbol.localeCompare(b.item.symbol),
    );
    return scored.slice(0, limit).map((entry) => entry.item);
  }

  private clampLimit(raw?: string): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SYMBOL_LIMIT;
    return Math.min(Math.floor(parsed), MAX_SYMBOL_LIMIT);
  }
}

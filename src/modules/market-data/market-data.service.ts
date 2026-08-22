import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '../../common/cache/cache.service';
import { cacheKeys, cacheTtl } from '../../common/cache/cache.keys';
import { MARKET_DATA_AS_OF } from '../../common/seed/money-space.seed';
import type { ListFxRatesQuery } from './dto/list-fx-rates.query';
import type { ListFxCounterRatesQuery } from './dto/list-fx-counter-rates.query';
import type { ListGoldPricesQuery } from './dto/list-gold-prices.query';
import type { GetQuoteQuery } from './dto/get-quote.query';
import type { ListMarketPricesQuery } from './dto/list-market-prices.query';
import { MARKET_DATA_REPOSITORY } from './repositories/market-data.repository.interface';
import type { MarketDataRepository } from './repositories/market-data.repository.interface';
import type { MarketPrice } from './entities/market-price.entity';
import type { FxCounterRate } from './entities/fx-rate.entity';
import type { GoldPrice } from './entities/gold-price.entity';
import { COMMODITY_PROVIDER } from './providers/commodity-provider.interface';
import type { CommodityProvider } from './providers/commodity-provider.interface';
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
import { isVietnameseEquity } from './providers/provider-routing';

const SEARCHABLE_CLASSES: SymbolAssetClass[] = [
  'stock',
  'crypto',
  'gold',
  'foreign_currency',
];
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
    @Inject(COMMODITY_PROVIDER)
    private readonly commodityProvider: CommodityProvider,
    private readonly cache: CacheService,
  ) {}

  private cachedPrices: MarketPrice[] = [];
  private pricesExpireAt = 0;
  private pricesInFlight?: Promise<MarketPrice[]>;

  /**
   * Latest provider quotes, cached in two layers and never persisted:
   *
   * 1. **In-process** (`pricesExpireAt`) — serves the common case with no I/O
   *    at all, and coalesces concurrent refreshes within one instance.
   * 2. **Redis** (`cacheKeys.marketPrices()`) — shared across instances and
   *    across restarts, so a cold instance does not re-hit the providers and
   *    every instance quotes the same figure. Fail-open: with Redis unset or
   *    down this degrades to layer 1 alone.
   *
   * `forceRefresh` (the daily valuation refresh) bypasses both layers and
   * rewrites them, so the refresh genuinely re-prices rather than re-reading
   * what it is about to replace.
   */
  async getMarketPrices(forceRefresh = false): Promise<MarketPrice[]> {
    const now = Date.now();
    if (!forceRefresh && now < this.pricesExpireAt) return this.cachedPrices;
    if (!forceRefresh && this.pricesInFlight) return this.pricesInFlight;
    const ttl = Number(process.env.MARKET_PRICE_CACHE_TTL_MS ?? 300_000);
    const ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : 300_000;
    this.pricesInFlight = this.loadPrices(forceRefresh, ttlMs)
      .then((prices) => {
        // Only let a non-empty result take over the cache; an empty provider
        // response must not evict quotes we can still serve.
        if (prices.length > 0 || this.cachedPrices.length === 0) {
          this.cachedPrices = prices;
          this.pricesExpireAt = Date.now() + ttlMs;
          return prices;
        }
        return this.cachedPrices;
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

  /**
   * The Redis layer under `getMarketPrices`. On a normal read it is a
   * read-through (`wrap`); on a forced refresh the providers are called
   * directly and the result is written back, so the refresh cannot be served
   * the very entry it is meant to replace.
   */
  private async loadPrices(
    forceRefresh: boolean,
    ttlMs: number,
  ): Promise<MarketPrice[]> {
    const key = cacheKeys.marketPrices();
    const ttlSeconds = Math.max(1, Math.round(ttlMs / 1000));

    if (forceRefresh) {
      const prices = await this.fetchPrices();
      // Don't overwrite a good entry with an empty provider response.
      if (prices.length > 0) await this.cache.set(key, prices, ttlSeconds);
      return prices;
    }

    return this.cache.wrap(key, () => this.fetchPrices(), ttlSeconds);
  }

  /** One provider round-trip over the whole distinct symbol universe. */
  private async fetchPrices(): Promise<MarketPrice[]> {
    const universe = await this.marketDataRepository.getMarketSymbolUniverse();
    return this.priceProvider.getLatestPrices(universe);
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

  /**
   * Price ONE instrument on demand, for the asset-create flow.
   *
   * Distinct from `listMarketPrices`, which only covers the universe of
   * positions households already hold — a symbol being added for the first time
   * is by definition not in that set yet, so it would come back empty.
   *
   * Returns `null` when the symbol cannot be priced (unknown ticker, provider
   * down, class with no provider). The caller shows the field as un-prefilled
   * and lets the user type a price rather than blocking creation.
   */
  async getQuote(query: GetQuoteQuery): Promise<MarketPrice | null> {
    const assetClass = query.assetClass;
    const symbol = query.symbol?.trim();
    if (!assetClass || !symbol) return null;

    const market = query.market?.trim().toUpperCase() ?? '';
    // Gold and foreign currency come from the Vietnamese commodity feed, so
    // they are always VND. VN equities are VND too; everything else defaults to
    // USD. Getting this wrong would ask a provider for a currency it cannot
    // convert to.
    const isVnd =
      assetClass === 'gold' ||
      assetClass === 'foreign_currency' ||
      isVietnameseEquity({
        assetClass,
        symbol,
        market: query.market,
        quoteCurrency: '',
      });
    const quoteCurrency = (
      query.quoteCurrency?.trim() || (isVnd ? 'VND' : 'USD')
    ).toUpperCase();

    return this.cache.wrap(
      cacheKeys.quote(assetClass, symbol.toUpperCase(), market, quoteCurrency),
      async () => {
        // Gold and foreign currency are priced by the commodity feed, not the
        // instrument providers — they have no ticker to look up.
        if (assetClass === 'gold' || assetClass === 'foreign_currency') {
          return this.commodityQuote(assetClass, symbol);
        }
        const quotes = await this.priceProvider.getLatestPrices([
          {
            assetClass,
            symbol,
            market: query.market,
            quoteCurrency,
          },
        ]);
        return quotes[0] ?? null;
      },
      cacheTtl.marketPrices,
    );
  }

  /**
   * Price a gold product or a foreign currency from the commodity feed.
   *
   * Both use the **sell** side — that is what the household would pay to
   * acquire the holding, so it is the figure that matches a position being
   * created. Gold falls back to the buy side when the dealer does not sell the
   * product (`sellPrice: null`), which is better than refusing to price a
   * holding the user genuinely has.
   */
  private async commodityQuote(
    assetClass: 'gold' | 'foreign_currency',
    symbol: string,
  ): Promise<MarketPrice | null> {
    const priceTime = new Date().toISOString();

    if (assetClass === 'gold') {
      const prices = await this.commodityProvider.getGoldPrices();
      const match = prices.find(
        (price) => price.name.trim().toUpperCase() === symbol.toUpperCase(),
      );
      const price = match?.sellPrice ?? match?.buyPrice;
      if (!match || !price) return null;
      return {
        assetClass: 'gold',
        symbol: match.name,
        price,
        // Dealers quote per lượng; the form converts for chỉ/gram holdings.
        unit: 'lượng',
        quoteCurrency: 'VND',
        priceTime: match.priceTime || priceTime,
        source: match.source,
      };
    }

    const rates = await this.commodityProvider.getFxCounterRates();
    const match = rates.find(
      (rate) => rate.currencyCode === symbol.toUpperCase(),
    );
    const price = match?.sell ?? match?.buyTransfer ?? match?.buyCash;
    if (!match || !price) return null;
    return {
      assetClass: 'foreign_currency',
      symbol: match.currencyCode,
      price,
      unit: match.currencyCode,
      quoteCurrency: 'VND',
      priceTime,
      source: match.source,
    };
  }

  /**
   * Persisted reference rates from `fx_rates`, cached so a page showing them
   * does not re-query Postgres on every request. The list is small and global,
   * so it is cached whole and filtered in memory.
   */
  async listFxRates(query: ListFxRatesQuery) {
    let items = [
      ...(await this.cache.wrap(
        cacheKeys.fxRates(),
        () => this.marketDataRepository.getFxRates(),
        cacheTtl.fxRates,
      )),
    ];
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
   * Live Vietnamese dealer gold quotes (VND per lượng), cached in Redis for
   * `cacheTtl.commodity`. Optionally filtered to one brand.
   *
   * Never throws on an upstream outage — the adapter yields `[]` and the
   * endpoint reports an empty list, so a dealer being down cannot 5xx a page
   * that merely shows gold alongside other figures.
   */
  async listGoldPrices(query: ListGoldPricesQuery = {}): Promise<{
    items: GoldPrice[];
    total: number;
  }> {
    let items = await this.cache.wrap(
      cacheKeys.goldPrices(),
      () => this.commodityProvider.getGoldPrices(),
      cacheTtl.commodity,
    );

    if (query.brand) {
      const needle = query.brand.trim().toUpperCase();
      items = items.filter(
        (item) =>
          item.brand.toUpperCase().includes(needle) ||
          item.name.toUpperCase().includes(needle),
      );
    }

    return { items, total: items.length };
  }

  /**
   * Live bank counter rates against VND (buy cash / buy transfer / sell),
   * cached in Redis for `cacheTtl.commodity`.
   *
   * Distinct from `listFxRates`, which serves the single persisted reference
   * rate from `fx_rates`; this is the three-way spread a household actually
   * transacts at.
   */
  async listFxCounterRates(query: ListFxCounterRatesQuery = {}): Promise<{
    items: FxCounterRate[];
    total: number;
  }> {
    let items = await this.cache.wrap(
      cacheKeys.fxCounterRates(),
      () => this.commodityProvider.getFxCounterRates(),
      cacheTtl.commodity,
    );

    if (query.currencyCode) {
      const needle = query.currencyCode.trim().toUpperCase();
      items = items.filter((item) => item.currencyCode === needle);
    }

    return { items, total: items.length };
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
    const reference = await this.listReference(assetClass);

    const items = term
      ? this.rankMatches(this.pool(assetClass, reference), term, limit)
      : this.defaultList(assetClass, reference, limit);

    return { assetClass, query: term, items, total: items.length };
  }

  /**
   * Reference list for a class, cached in Redis so the picker does not re-hit
   * the providers on every keystroke and every instance shares one listing.
   * The adapters keep their own 24h in-process cache underneath, so a Redis
   * miss is still cheap; this layer is what survives a restart and is shared.
   *
   * An empty list is never cached — that is the "upstream unavailable" signal
   * the curated fallback depends on, and memoising it for 24h would pin the
   * picker to defaults long after the provider recovered.
   */
  private async listReference(
    assetClass: SymbolAssetClass,
  ): Promise<SymbolReference[]> {
    const key = cacheKeys.symbolReference(assetClass);
    const cached = await this.cache.get<SymbolReference[]>(key);
    if (cached !== undefined) return cached;

    const reference =
      await this.symbolReferenceProvider.listSymbols(assetClass);
    if (reference.length > 0) {
      await this.cache.set(key, reference, cacheTtl.symbolReference);
    }
    return reference;
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
    // Gold/silver and foreign currency are already short, fully curated lists —
    // the dealer's products and the supported currencies. Filtering them
    // through a hard-coded shortlist would hide most of what the user can
    // actually pick. Stock and crypto run to thousands, so those still lead
    // with the curated popular names.
    if (assetClass === 'gold' || assetClass === 'foreign_currency') {
      return reference.length > 0
        ? reference.slice(0, limit)
        : DEFAULT_SYMBOLS[assetClass].slice(0, limit);
    }

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

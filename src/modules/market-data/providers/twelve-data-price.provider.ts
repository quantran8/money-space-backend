import { Injectable, Logger } from '@nestjs/common';
import type { AssetClass } from '../../assets/entities/asset.entity';
import type { MarketPrice } from '../entities/market-price.entity';
import type { PriceProvider } from './price-provider.interface';
import type { SymbolRequest } from './symbol-request';

/** Asset classes this adapter prices. Gold & FX stay on their existing sources. */
const SUPPORTED_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>([
  'stock',
  'fund',
  'crypto',
]);

const DEFAULT_BASE_URL = 'https://api.twelvedata.com';

/** Shape of one entry in Twelve Data's `/price` batch response. */
interface TwelveDataPriceEntry {
  price?: string;
  status?: string;
  code?: number;
  message?: string;
}

/**
 * Twelve Data quote adapter (https://twelvedata.com).
 *
 * Prices stock, fund (equities/ETFs) and crypto (as `SYMBOL/USD` pairs) via the
 * batch `/price` endpoint — one upstream call for the whole distinct symbol
 * universe. Partial upstream failures are skipped per-symbol, never thrown, so
 * one bad ticker can't poison the batch. With no API key configured it behaves
 * like the noop provider (returns `[]`), keeping key-less environments working.
 */
@Injectable()
export class TwelveDataPriceProvider implements PriceProvider {
  private readonly logger = new Logger(TwelveDataPriceProvider.name);
  private readonly apiKey = process.env.TWELVEDATA_API_KEY ?? '';
  private readonly baseUrl = (
    process.env.TWELVEDATA_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/$/, '');

  async getLatestPrices(
    requests: SymbolRequest[] = [],
  ): Promise<MarketPrice[]> {
    if (!this.apiKey) {
      this.logger.warn('TWELVEDATA_API_KEY not set — returning no quotes');
      return [];
    }

    // De-duplicate by the ticker we send upstream while keeping every position
    // symbol that maps onto it (two positions may share a provider ticker).
    const priced = requests.filter((r) => SUPPORTED_CLASSES.has(r.assetClass));
    if (priced.length === 0) return [];

    const byTicker = new Map<string, SymbolRequest[]>();
    for (const request of priced) {
      const ticker = this.providerTicker(request);
      const group = byTicker.get(ticker);
      if (group) group.push(request);
      else byTicker.set(ticker, [request]);
    }

    const tickers = [...byTicker.keys()];
    const quotes = await this.fetchPrices(tickers);
    if (!quotes) return [];

    const priceTime = new Date().toISOString();
    const results: MarketPrice[] = [];
    for (const [ticker, group] of byTicker) {
      const entry = quotes[ticker];
      const price = this.parsePrice(entry);
      if (price === null) {
        this.logger.warn(
          `No price for "${ticker}"${entry?.message ? `: ${entry.message}` : ''}`,
        );
        continue;
      }
      for (const request of group) {
        results.push({
          assetClass: request.assetClass,
          symbol: request.symbol,
          price,
          unit: request.symbol,
          // Twelve Data crypto/equity prices are USD; the position's own
          // quoteCurrency is used only when it explicitly differs.
          quoteCurrency: request.quoteCurrency || 'USD',
          priceTime,
          source: 'twelvedata',
        });
      }
    }
    return results;
  }

  /** Map one position to the ticker Twelve Data expects. */
  private providerTicker(request: SymbolRequest): string {
    if (request.providerSymbol && request.providerSymbol.trim()) {
      return request.providerSymbol.trim().toUpperCase();
    }
    const symbol = request.symbol.trim().toUpperCase();
    if (request.assetClass === 'crypto') {
      // Twelve Data prices crypto as a pair, e.g. BTC/USD. Leave an already
      // pair-formatted symbol (contains "/") untouched.
      return symbol.includes('/')
        ? symbol
        : `${symbol}/${(request.quoteCurrency || 'USD').toUpperCase()}`;
    }
    return symbol;
  }

  private parsePrice(entry?: TwelveDataPriceEntry): number | null {
    if (!entry || entry.status === 'error' || entry.price === undefined) {
      return null;
    }
    const value = Number(entry.price);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Batch `/price` call. Returns a ticker→entry map, or null when the whole call
   * fails (network/HTTP/auth error) so the caller keeps the previous cache.
   * Twelve Data returns a bare `{ price }` object for a single symbol and a
   * ticker-keyed map for many — both are normalised here.
   */
  private async fetchPrices(
    tickers: string[],
  ): Promise<Record<string, TwelveDataPriceEntry> | null> {
    const url = new URL(`${this.baseUrl}/price`);
    url.searchParams.set('symbol', tickers.join(','));
    url.searchParams.set('apikey', this.apiKey);

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.logger.error(
          `Twelve Data /price returned HTTP ${response.status}`,
        );
        return null;
      }
      const body = (await response.json()) as
        TwelveDataPriceEntry | Record<string, TwelveDataPriceEntry>;

      // A top-level error object (e.g. rate limit, bad key) aborts the batch.
      if ((body as TwelveDataPriceEntry).status === 'error') {
        this.logger.error(
          `Twelve Data error: ${(body as TwelveDataPriceEntry).message ?? 'unknown'}`,
        );
        return null;
      }

      // Single-symbol responses come back un-keyed as `{ price: ... }`.
      if ('price' in body || 'status' in body) {
        return { [tickers[0]]: body };
      }
      return body as Record<string, TwelveDataPriceEntry>;
    } catch (error) {
      this.logger.error(
        `Twelve Data /price request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}

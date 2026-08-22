import { Injectable, Logger } from '@nestjs/common';
import type { AssetClass } from '../../assets/entities/asset.entity';
import type { MarketPrice } from '../entities/market-price.entity';
import type { PriceProvider } from './price-provider.interface';
import type { SymbolRequest } from './symbol-request';

/** CoinMarketCap only quotes crypto; every other class stays on its own source. */
const SUPPORTED_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>([
  'crypto',
]);

const DEFAULT_BASE_URL = 'https://pro-api.coinmarketcap.com';

/** One `quote` entry keyed by convert-currency in CMC's v2 quotes response. */
interface CmcQuote {
  price?: number | null;
  last_updated?: string;
}

/** One coin entry in `/v2/cryptocurrency/quotes/latest`. */
interface CmcQuoteEntry {
  symbol?: string;
  name?: string;
  quote?: Record<string, CmcQuote | undefined>;
}

/**
 * CMC returns `data` keyed by the requested symbol. On v2 each key holds an
 * ARRAY of matching coins (symbols are not unique upstream — e.g. several coins
 * ticker as "UNI"); v1 returned a bare object. Both are handled.
 */
type CmcQuotesData = Record<
  string,
  CmcQuoteEntry | CmcQuoteEntry[] | undefined
>;

interface CmcResponseBody {
  data?: CmcQuotesData;
  status?: { error_code?: number; error_message?: string | null };
}

/**
 * CoinMarketCap quote adapter (https://coinmarketcap.com/api).
 *
 * Prices crypto via the batch `/v2/cryptocurrency/quotes/latest` endpoint — one
 * upstream call per distinct convert-currency, since CMC converts a whole
 * symbol batch into a single fiat at a time. Partial upstream failures are
 * skipped per-symbol, never thrown, so one bad ticker can't poison the batch.
 * With no API key configured it behaves like the noop provider (returns `[]`).
 */
@Injectable()
export class CoinMarketCapPriceProvider implements PriceProvider {
  private readonly logger = new Logger(CoinMarketCapPriceProvider.name);
  private readonly apiKey = process.env.COIN_MARKETCAP_API_KEY ?? '';
  private readonly baseUrl = (
    process.env.COIN_MARKETCAP_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/$/, '');

  async getLatestPrices(
    requests: SymbolRequest[] = [],
  ): Promise<MarketPrice[]> {
    if (!this.apiKey) {
      this.logger.warn('COIN_MARKETCAP_API_KEY not set — returning no quotes');
      return [];
    }

    const priced = requests.filter((r) => SUPPORTED_CLASSES.has(r.assetClass));
    if (priced.length === 0) return [];

    // CMC converts one fiat per call, so group by convert-currency first, then
    // de-duplicate tickers within each group (two positions may share a ticker).
    const byCurrency = new Map<string, Map<string, SymbolRequest[]>>();
    for (const request of priced) {
      const convert = (request.quoteCurrency || 'USD').toUpperCase();
      const ticker = this.providerTicker(request);
      let group = byCurrency.get(convert);
      if (!group) {
        group = new Map<string, SymbolRequest[]>();
        byCurrency.set(convert, group);
      }
      const bucket = group.get(ticker);
      if (bucket) bucket.push(request);
      else group.set(ticker, [request]);
    }

    // One call per convert-currency; a failed currency yields no quotes for that
    // group while the others still resolve.
    const batches = await Promise.all(
      [...byCurrency].map(async ([convert, group]) => ({
        convert,
        group,
        quotes: await this.fetchQuotes([...group.keys()], convert),
      })),
    );

    const priceTime = new Date().toISOString();
    const results: MarketPrice[] = [];
    for (const { convert, group, quotes } of batches) {
      if (!quotes) continue;
      for (const [ticker, bucket] of group) {
        const price = this.parsePrice(quotes[ticker], convert);
        if (price === null) {
          this.logger.warn(`No ${convert} price for "${ticker}"`);
          continue;
        }
        for (const request of bucket) {
          results.push({
            assetClass: request.assetClass,
            symbol: request.symbol,
            price,
            unit: request.symbol,
            quoteCurrency: convert,
            priceTime,
            source: 'coinmarketcap',
          });
        }
      }
    }
    return results;
  }

  /**
   * Map one position to the ticker CMC expects: a bare base symbol. Unlike
   * Twelve Data, CMC takes the coin ticker and the fiat separately, so a
   * pair-formatted symbol ("BTC/USD") is reduced to its base.
   */
  private providerTicker(request: SymbolRequest): string {
    const raw =
      request.providerSymbol && request.providerSymbol.trim()
        ? request.providerSymbol
        : request.symbol;
    return raw.trim().toUpperCase().split('/')[0];
  }

  /**
   * Pick the converted price. A v2 key holds an array of same-ticker coins —
   * CMC ranks them by market cap, so the first entry is the canonical coin.
   */
  private parsePrice(
    entry: CmcQuoteEntry | CmcQuoteEntry[] | undefined,
    convert: string,
  ): number | null {
    const coin = Array.isArray(entry) ? entry[0] : entry;
    const value = coin?.quote?.[convert]?.price;
    if (value === undefined || value === null) return null;
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Batch quotes call for one convert-currency. Returns the symbol-keyed data
   * map, or null when the whole call fails (network/HTTP/auth/rate-limit error)
   * so the caller keeps the previous cache instead of publishing empty prices.
   */
  private async fetchQuotes(
    tickers: string[],
    convert: string,
  ): Promise<CmcQuotesData | null> {
    const url = new URL(`${this.baseUrl}/v2/cryptocurrency/quotes/latest`);
    url.searchParams.set('symbol', tickers.join(','));
    url.searchParams.set('convert', convert);

    try {
      const response = await fetch(url, {
        headers: {
          'X-CMC_PRO_API_KEY': this.apiKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.logger.error(
          `CoinMarketCap quotes/latest returned HTTP ${response.status}`,
        );
        return null;
      }
      const body = (await response.json()) as CmcResponseBody;
      if (body.status?.error_code) {
        this.logger.error(
          `CoinMarketCap error: ${body.status.error_message ?? 'unknown'}`,
        );
        return null;
      }
      return body.data ?? {};
    } catch (error) {
      this.logger.error(
        `CoinMarketCap quotes/latest request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type { SymbolReference } from '../entities/symbol-reference.entity';
import type {
  SymbolAssetClass,
  SymbolReferenceProvider,
} from './symbol-reference-provider.interface';

const DEFAULT_BASE_URL = 'https://pro-api.coinmarketcap.com';
const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — the coin map barely changes.
/** CMC caps `limit` at 5000 per call; that covers the coins worth listing. */
const LISTING_LIMIT = 5000;

/** One row of `/v1/cryptocurrency/map`. */
interface CmcMapRow {
  id?: number;
  name?: string;
  symbol?: string;
  rank?: number | null;
  is_active?: number;
}

interface CmcMapBody {
  data?: CmcMapRow[];
  status?: { error_code?: number; error_message?: string | null };
}

interface CacheEntry {
  value: SymbolReference[];
  expiresAt: number;
  inFlight?: Promise<SymbolReference[]>;
}

/**
 * CoinMarketCap reference-data adapter (https://coinmarketcap.com/api). Fetches
 * the `/v1/cryptocurrency/map` listing once and caches it in process for 24h —
 * a large, near-static list, so the app pulls it once and serves search / the
 * default list from memory rather than spending call credits per keystroke.
 *
 * Crypto only: `listSymbols('stock')` returns `[]` so the router can keep
 * equities on their own provider. With no API key it returns `[]` (the picker
 * then shows only curated defaults, which the service resolves without upstream
 * data).
 */
@Injectable()
export class CoinMarketCapSymbolReferenceProvider implements SymbolReferenceProvider {
  private readonly logger = new Logger(
    CoinMarketCapSymbolReferenceProvider.name,
  );
  private readonly apiKey = process.env.COIN_MARKETCAP_API_KEY ?? '';
  private readonly baseUrl = (
    process.env.COIN_MARKETCAP_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/$/, '');
  private cache?: CacheEntry;

  async listSymbols(assetClass: SymbolAssetClass): Promise<SymbolReference[]> {
    if (assetClass !== 'crypto' || !this.apiKey) return [];

    const entry = this.cache;
    if (entry && Date.now() < entry.expiresAt) return entry.value;
    if (entry?.inFlight) return entry.inFlight;

    const inFlight = this.fetchCryptocurrencies()
      .then((value) => {
        // Only overwrite the cache with a non-empty list; a transient upstream
        // failure keeps whatever we had rather than caching an empty list.
        if (value.length > 0) {
          this.cache = { value, expiresAt: Date.now() + REFERENCE_TTL_MS };
          return value;
        }
        return entry?.value ?? [];
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to load crypto reference list: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return entry?.value ?? [];
      })
      .finally(() => {
        if (this.cache) this.cache.inFlight = undefined;
      });

    // Track the in-flight promise so concurrent callers coalesce.
    this.cache = {
      value: entry?.value ?? [],
      expiresAt: entry?.expiresAt ?? 0,
      inFlight,
    };
    return inFlight;
  }

  private async fetchCryptocurrencies(): Promise<SymbolReference[]> {
    const url = new URL(`${this.baseUrl}/v1/cryptocurrency/map`);
    url.searchParams.set('listing_status', 'active');
    // Rank-sorted so the most significant coins win the symbol de-dupe below.
    url.searchParams.set('sort', 'cmc_rank');
    url.searchParams.set('limit', String(LISTING_LIMIT));

    const response = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': this.apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(
        `CoinMarketCap cryptocurrency/map returned HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as CmcMapBody;
    if (body.status?.error_code) {
      throw new Error(
        body.status.error_message ?? 'CoinMarketCap cryptocurrency/map error',
      );
    }

    const rows = Array.isArray(body.data) ? body.data : [];
    const seen = new Set<string>();
    const result: SymbolReference[] = [];
    for (const row of rows) {
      const symbol = row.symbol?.trim();
      // Tickers are not unique on CMC; rank order means the first row for a
      // symbol is the highest-ranked coin, so later duplicates are dropped.
      if (!symbol || seen.has(symbol.toUpperCase())) continue;
      seen.add(symbol.toUpperCase());
      result.push({
        assetClass: 'crypto',
        symbol,
        name: row.name?.trim() || symbol,
        exchange: '',
        currency: 'USD',
        unit: 'coin',
      });
    }
    return result;
  }
}

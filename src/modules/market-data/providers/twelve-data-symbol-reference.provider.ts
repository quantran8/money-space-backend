import { Injectable, Logger } from '@nestjs/common';
import type { SymbolReference } from '../entities/symbol-reference.entity';
import type {
  SymbolAssetClass,
  SymbolReferenceProvider,
} from './symbol-reference-provider.interface';

const DEFAULT_BASE_URL = 'https://api.twelvedata.com';
const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — reference lists barely change.

interface TwelveDataStockRow {
  symbol?: string;
  name?: string;
  currency?: string;
  exchange?: string;
  type?: string;
}

interface TwelveDataCryptoRow {
  symbol?: string; // e.g. "BTC/USD"
  currency_base?: string; // e.g. "Bitcoin"
  currency_quote?: string; // e.g. "US Dollar"
}

interface CacheEntry {
  value: SymbolReference[];
  expiresAt: number;
  inFlight?: Promise<SymbolReference[]>;
}

/**
 * Twelve Data reference-data adapter (https://twelvedata.com). Fetches the full
 * `/stocks` and `/cryptocurrencies` lists once and caches them in process for
 * 24h — these are large, near-static lists that are not per-quote rate limited,
 * so the app pulls each once and serves search / the default list from memory.
 * With no API key it returns `[]` (the picker then shows only curated defaults
 * that the service resolves without upstream data).
 */
@Injectable()
export class TwelveDataSymbolReferenceProvider implements SymbolReferenceProvider {
  private readonly logger = new Logger(TwelveDataSymbolReferenceProvider.name);
  private readonly apiKey = process.env.TWELVEDATA_API_KEY ?? '';
  private readonly baseUrl = (
    process.env.TWELVEDATA_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/$/, '');
  private readonly cache = new Map<SymbolAssetClass, CacheEntry>();

  async listSymbols(assetClass: SymbolAssetClass): Promise<SymbolReference[]> {
    if (!this.apiKey) return [];

    const now = Date.now();
    const entry = this.cache.get(assetClass);
    if (entry && now < entry.expiresAt) return entry.value;
    if (entry?.inFlight) return entry.inFlight;

    const inFlight = this.fetchClass(assetClass)
      .then((value) => {
        // Only overwrite the cache with a non-empty list; a transient upstream
        // failure keeps whatever we had rather than caching an empty list.
        if (value.length > 0) {
          this.cache.set(assetClass, {
            value,
            expiresAt: Date.now() + REFERENCE_TTL_MS,
          });
          return value;
        }
        return entry?.value ?? [];
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to load ${assetClass} reference list: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return entry?.value ?? [];
      })
      .finally(() => {
        const current = this.cache.get(assetClass);
        if (current) current.inFlight = undefined;
      });

    // Track the in-flight promise so concurrent callers coalesce.
    this.cache.set(assetClass, {
      value: entry?.value ?? [],
      expiresAt: entry?.expiresAt ?? 0,
      inFlight,
    });
    return inFlight;
  }

  private async fetchClass(
    assetClass: SymbolAssetClass,
  ): Promise<SymbolReference[]> {
    return assetClass === 'stock'
      ? this.fetchStocks()
      : this.fetchCryptocurrencies();
  }

  private async fetchStocks(): Promise<SymbolReference[]> {
    const rows = await this.fetchData<TwelveDataStockRow>('/stocks');
    const seen = new Set<string>();
    const result: SymbolReference[] = [];
    for (const row of rows) {
      const symbol = row.symbol?.trim();
      if (!symbol || seen.has(symbol.toUpperCase())) continue;
      seen.add(symbol.toUpperCase());
      result.push({
        assetClass: 'stock',
        symbol,
        name: row.name?.trim() || symbol,
        exchange: row.exchange?.trim() || '',
        currency: row.currency?.trim() || 'USD',
        unit: 'cp',
      });
    }
    return result;
  }

  private async fetchCryptocurrencies(): Promise<SymbolReference[]> {
    const rows = await this.fetchData<TwelveDataCryptoRow>('/cryptocurrencies');
    const seen = new Set<string>();
    const result: SymbolReference[] = [];
    for (const row of rows) {
      // Twelve Data crypto symbols are pairs ("BTC/USD"); reduce to the base
      // ticker so the picker shows BTC/ETH/…, deduping across quote currencies.
      const base = row.symbol?.split('/')[0]?.trim();
      if (!base || seen.has(base.toUpperCase())) continue;
      seen.add(base.toUpperCase());
      result.push({
        assetClass: 'crypto',
        symbol: base,
        name: row.currency_base?.trim() || base,
        exchange: '',
        currency: 'USD',
        unit: 'coin',
      });
    }
    return result;
  }

  private async fetchData<T>(path: string): Promise<T[]> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('apikey', this.apiKey);

    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new Error(`Twelve Data ${path} returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: T[];
      status?: string;
      message?: string;
    };
    if (body.status === 'error') {
      throw new Error(body.message ?? `Twelve Data ${path} error`);
    }
    return Array.isArray(body.data) ? body.data : [];
  }
}

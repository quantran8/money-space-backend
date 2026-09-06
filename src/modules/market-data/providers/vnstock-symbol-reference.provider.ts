import { Injectable, Logger } from '@nestjs/common';
import { init, stock } from 'vnstock-js';
import type { SymbolReference } from '../entities/symbol-reference.entity';
import type {
  SymbolAssetClass,
  SymbolReferenceProvider,
} from './symbol-reference-provider.interface';
import { VnstockPriceProvider } from './vnstock-price.provider';

/** Widest the bundled directory goes; it is a local list, not a paged API. */
const DIRECTORY_LIMIT = 5000;

/**
 * Covered warrants (chứng quyền, e.g. `CVNM2511`) trade on HSX like shares, so
 * the exchange filter alone lets them through. They are short-dated derivatives
 * that expire worthless, not a holding a household tracks as an asset — and
 * they crowd out the underlying share in search (typing "VNM" surfaced four of
 * them above VNM itself). Identified by the name the directory gives them.
 */
const WARRANT_MARKER = /chứng quyền|covered warrant/i;
const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — the listing barely changes.

/**
 * Vietnamese equity reference data from `vnstock-js`.
 *
 * Unlike the other reference adapters this needs **no network call per lookup**:
 * `stock.search` is a synchronous query over a directory bundled with the
 * package, which `init()` loads once. The 24h cache therefore exists to avoid
 * re-filtering ~3.3k rows on every keystroke, not to save API credits.
 *
 * Only tradable HSX/HNX/UPCOM equities are listed. The raw directory also
 * carries ~1.4k `DELISTED` rows and ~85 `BOND` rows (plus covered warrants such
 * as `CVNM2111`) — offering those in the asset-create picker would let someone
 * hold a position nothing can ever price.
 */
@Injectable()
export class VnstockSymbolReferenceProvider implements SymbolReferenceProvider {
  private readonly logger = new Logger(VnstockSymbolReferenceProvider.name);
  private cache?: { value: SymbolReference[]; expiresAt: number };
  private initialised?: Promise<void>;

  async listSymbols(assetClass: SymbolAssetClass): Promise<SymbolReference[]> {
    if (assetClass !== 'stock') return [];

    const entry = this.cache;
    if (entry && Date.now() < entry.expiresAt) return entry.value;

    try {
      const value = await this.loadDirectory();
      // Keep the previous list rather than caching an empty one.
      if (value.length === 0) return entry?.value ?? [];
      this.cache = { value, expiresAt: Date.now() + REFERENCE_TTL_MS };
      return value;
    } catch (error) {
      this.logger.error(
        `Failed to load VN equity directory: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return entry?.value ?? [];
    }
  }

  /**
   * `init()` loads the bundled directory and must run once before `search`;
   * calling it concurrently would load it repeatedly, so the promise is reused.
   */
  private ensureInitialised(): Promise<void> {
    this.initialised ??= init();
    return this.initialised;
  }

  private async loadDirectory(): Promise<SymbolReference[]> {
    await this.ensureInitialised();
    // An empty query returns the whole directory; it is local, so this is a
    // filter over an in-memory array rather than a request.
    const rows = stock.search('', { limit: DIRECTORY_LIMIT });

    const seen = new Set<string>();
    const result: SymbolReference[] = [];
    for (const row of rows) {
      const symbol = row.symbol?.trim();
      const exchange = row.exchange?.trim() ?? '';
      if (!symbol || !VnstockPriceProvider.isTradableExchange(exchange)) {
        continue;
      }
      const label = `${row.companyName ?? ''} ${row.companyNameEn ?? ''}`;
      if (WARRANT_MARKER.test(label)) continue;
      if (seen.has(symbol.toUpperCase())) continue;
      seen.add(symbol.toUpperCase());
      result.push({
        assetClass: 'stock',
        symbol,
        // Vietnamese name first — this is a Vietnamese-first app; the English
        // name is only a fallback for rows that lack one.
        name: row.companyName?.trim() || row.companyNameEn?.trim() || symbol,
        exchange,
        currency: 'VND',
        unit: 'cp',
        vn30: row.vn30 === true,
      });
    }
    return result;
  }
}

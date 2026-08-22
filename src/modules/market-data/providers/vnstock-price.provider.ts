import { Injectable, Logger } from '@nestjs/common';
import { Vnstock } from 'vnstock-js';
import type { AssetClass } from '../../assets/entities/asset.entity';
import type { MarketPrice } from '../entities/market-price.entity';
import type { PriceProvider } from './price-provider.interface';
import type { SymbolRequest } from './symbol-request';

/** Vietnamese equities only; every other class stays on its own source. */
const SUPPORTED_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>([
  'stock',
  'fund',
]);

/** vnstock quotes in THOUSANDS of VND (VNM `63.8` = 63,800đ). See memory/market-data.md. */
const VND_PRICE_SCALE = 1000;

/** vnstock returns HSX/HNX/UPCOM for live boards; anything else is not tradable. */
const TRADABLE_EXCHANGES: ReadonlySet<string> = new Set([
  'HSX',
  'HOSE',
  'HNX',
  'UPCOM',
]);

/**
 * Vietnamese equity adapter (`vnstock-js`). Batches the whole VN slice into one
 * `priceBoard` call; needs no API key. Always emits VND.
 */
@Injectable()
export class VnstockPriceProvider implements PriceProvider {
  private readonly logger = new Logger(VnstockPriceProvider.name);
  private readonly vnstock = new Vnstock();

  async getLatestPrices(
    requests: SymbolRequest[] = [],
  ): Promise<MarketPrice[]> {
    const priced = requests.filter(
      (r) => SUPPORTED_CLASSES.has(r.assetClass) && this.isVnQuoted(r),
    );
    if (priced.length === 0) return [];

    // De-duplicate by upstream ticker while keeping every position that maps
    // onto it (two positions may share a ticker).
    const byTicker = new Map<string, SymbolRequest[]>();
    for (const request of priced) {
      const ticker = this.providerTicker(request);
      const group = byTicker.get(ticker);
      if (group) group.push(request);
      else byTicker.set(ticker, [request]);
    }

    const board = await this.fetchPriceBoard([...byTicker.keys()]);
    if (!board) return [];

    // The board is keyed by symbol; match case-insensitively.
    const bySymbol = new Map(
      board.map((item) => [item.symbol?.trim().toUpperCase() ?? '', item]),
    );

    const priceTime = new Date().toISOString();
    const results: MarketPrice[] = [];
    for (const [ticker, group] of byTicker) {
      const price = this.parsePrice(bySymbol.get(ticker));
      if (price === null) {
        this.logger.warn(`No price for "${ticker}"`);
        continue;
      }
      for (const request of group) {
        results.push({
          assetClass: request.assetClass,
          symbol: request.symbol,
          price,
          unit: request.symbol,
          quoteCurrency: 'VND',
          priceTime,
          source: 'vnstock',
        });
      }
    }
    return results;
  }

  /** VN equities are VND-only; another currency is left to another provider. */
  private isVnQuoted(request: SymbolRequest): boolean {
    const currency = (request.quoteCurrency || 'VND').toUpperCase();
    return currency === 'VND';
  }

  /** Map one position to the ticker vnstock expects: a bare 3-letter code. */
  private providerTicker(request: SymbolRequest): string {
    const raw =
      request.providerSymbol && request.providerSymbol.trim()
        ? request.providerSymbol
        : request.symbol;
    return raw.trim().toUpperCase();
  }

  /** Matched price, else the reference price for a ticker that has not traded. */
  private parsePrice(item?: {
    price?: number;
    referencePrice?: number;
  }): number | null {
    for (const candidate of [item?.price, item?.referencePrice]) {
      if (
        candidate !== undefined &&
        candidate !== null &&
        Number.isFinite(candidate) &&
        candidate > 0
      ) {
        return candidate * VND_PRICE_SCALE;
      }
    }
    return null;
  }

  /** Null on failure, so the caller keeps its previous cache. */
  private async fetchPriceBoard(tickers: string[]): Promise<Array<{
    symbol?: string;
    price?: number;
    referencePrice?: number;
  }> | null> {
    try {
      const board = await this.vnstock.stock.trading.priceBoard(tickers);
      return Array.isArray(board) ? board : [];
    } catch (error) {
      this.logger.error(
        `vnstock priceBoard request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** Exposed for the reference provider so both agree on what is tradable. */
  static isTradableExchange(exchange: string): boolean {
    return TRADABLE_EXCHANGES.has(exchange.trim().toUpperCase());
  }
}

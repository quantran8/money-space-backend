import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { commodity } from 'vnstock-js';
import type { FxCounterRate } from '../entities/fx-rate.entity';
import type { GoldPrice } from '../entities/gold-price.entity';
import type { CommodityProvider } from './commodity-provider.interface';

/** Upstream gold row (BTMC shape); every field arrives as a string. */
interface RawGoldRow {
  name?: string;
  karat?: string;
  weight?: string;
  buyPrice?: string | number;
  sellPrice?: string | number;
  updatedAt?: string;
}

/** Transport details vnstock attaches to a wrapped upstream error. */
interface UpstreamCause {
  code: string;
  status: number;
  url: string;
}

/** Secondary gold feed row (giavang.net shape), after vnstock's transform. */
interface RawGiaVangRow {
  code?: string;
  buyPrice?: string | number;
  sellPrice?: string | number;
  updatedAt?: string | number;
}

/** Upstream bank counter-rate row; every field arrives as a string. */
interface RawExchangeRow {
  currencyCode?: string;
  currencyName?: string;
  buyCash?: string | number;
  buyTransfer?: string | number;
  sell?: string | number;
}

/**
 * Gold and bank FX counter rates (`vnstock-js`, no API key). Never throws — an
 * upstream failure yields `[]`. See memory/market-data.md.
 */
/**
 * Hard ceiling on an upstream call. vnstock retries internally (3 attempts x 15s
 * timeout), so a slow dealer feed can otherwise hold a request ~48s.
 */
const UPSTREAM_TIMEOUT_MS = Number(process.env.COMMODITY_TIMEOUT_MS ?? 10000);

/**
 * Fewest gold rows a complete BTMC payload can carry. The feed republishes ~10
 * products per publish time across several times a day, so a healthy response
 * is ~90 rows; anything near the floor means the body was cut off mid-stream.
 * Overridable via `COMMODITY_MIN_GOLD_ROWS`.
 */
const MIN_GOLD_ROWS = Number(process.env.COMMODITY_MIN_GOLD_ROWS ?? 20);

/**
 * giavang.net `type_code` → the BTMC product it quotes, so a fallback round
 * yields the same symbols the allowlist and stored assets already use. Index
 * codes (XAUUSD, USDX) are deliberately absent: they are not retail products.
 */
const GIAVANGNET_PRODUCTS: Readonly<
  Record<string, { name: string; brand: string }>
> = {
  BTSJC: { name: 'VÀNG MIẾNG SJC', brand: 'Vàng SJC' },
  SJL1L10: { name: 'VÀNG MIẾNG SJC', brand: 'Vàng SJC' },
  VNGSJC: { name: 'VÀNG MIẾNG SJC', brand: 'Vàng SJC' },
  VIETTINMSJC: { name: 'VÀNG MIẾNG SJC', brand: 'Vàng SJC' },
  BT9999NTT: { name: 'NHẪN TRÒN TRƠN', brand: 'Vàng Rồng Thăng Long' },
  PQHN24NTT: { name: 'NHẪN TRÒN TRƠN', brand: 'Vàng Rồng Thăng Long' },
  DOJINHTV: { name: 'VÀNG MIẾNG VRTL', brand: 'Vàng Rồng Thăng Long' },
  PQHNVM: { name: 'VÀNG MIẾNG VRTL', brand: 'Vàng Rồng Thăng Long' },
};

@Injectable()
export class VnstockCommodityProvider
  implements CommodityProvider, OnModuleInit
{
  private readonly logger = new Logger(VnstockCommodityProvider.name);

  /** Last good result, served when the upstream is slow or down. */
  private lastGold: GoldPrice[] = [];
  private lastRates: FxCounterRate[] = [];

  /** Coalesces concurrent callers onto one upstream call. */
  private goldInFlight?: Promise<GoldPrice[]>;
  private ratesInFlight?: Promise<FxCounterRate[]>;

  /** Warm the stale cache at boot so the first real request never pays for it. */
  onModuleInit(): void {
    void this.getGoldPrices();
    void this.getFxCounterRates();
  }

  /** Rejects if `work` outruns the deadline, so a request is never held hostage. */
  private withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
    return Promise.race([
      work,
      new Promise<T>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`${label} timed out after ${UPSTREAM_TIMEOUT_MS}ms`),
            ),
          UPSTREAM_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
  }

  async getGoldPrices(): Promise<GoldPrice[]> {
    this.goldInFlight ??= this.fetchGold()
      .catch((error: unknown) => {
        this.logger.error(
          `vnstock gold price request failed: ${this.describeError(error)}`,
        );
        // Stale beats empty: an empty list reads as "no such product".
        return this.lastGold;
      })
      .finally(() => {
        this.goldInFlight = undefined;
      });
    return this.goldInFlight;
  }

  /**
   * BTMC first, retried once on a short body, then giavang.net.
   *
   * BTMC is plain HTTP and the connection can drop mid-body on the way out of
   * the region: axios resolves with whatever arrived, so a truncated feed looks
   * like a success. See memory/market-data.md.
   */
  private async fetchGold(): Promise<GoldPrice[]> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.withTimeout(
        commodity.gold.price({ source: 'btmc' }),
        'gold price',
      );
      const rowCount = Array.isArray(result?.data) ? result.data.length : 0;
      if (rowCount >= MIN_GOLD_ROWS) {
        const parsed = this.parseGold(result);
        if (parsed.length > 0) {
          this.lastGold = parsed;
          return parsed;
        }
      }
      this.logger.warn(
        `btmc gold feed looks truncated: ${rowCount} rows (min ${MIN_GOLD_ROWS})`,
      );
    }

    const fallback = await this.fetchGoldFromGiaVangNet();
    if (fallback.length > 0) {
      this.lastGold = fallback;
      return fallback;
    }
    // A partial list is worse than a stale one: it silently drops products the
    // user holds, so both the symbol list and the quote go missing.
    return this.lastGold;
  }

  /**
   * Secondary feed. Its rows are keyed by `type_code` and carry no product
   * name, so each code is mapped onto the BTMC product it quotes.
   */
  private async fetchGoldFromGiaVangNet(): Promise<GoldPrice[]> {
    try {
      const result = await this.withTimeout(
        commodity.gold.price({ source: 'giavangnet' }),
        'gold price (giavangnet)',
      );
      const rows: RawGiaVangRow[] = Array.isArray(result?.data)
        ? result.data
        : [];

      const latest = new Map<string, GoldPrice>();
      for (const row of rows) {
        const product =
          GIAVANGNET_PRODUCTS[row.code?.trim().toUpperCase() ?? ''];
        if (!product) continue;
        const buyPrice = this.parseAmount(row.buyPrice);
        const sellPrice = this.parseAmount(row.sellPrice);
        if (buyPrice === null && sellPrice === null) continue;
        // Several codes quote the same product; the first mapped one wins.
        if (latest.has(product.name)) continue;
        latest.set(product.name, {
          name: product.name,
          brand: product.brand,
          karat: '',
          fineness: '',
          buyPrice: buyPrice ?? 0,
          sellPrice,
          priceTime: this.parseEpoch(row.updatedAt),
          source: 'giavangnet',
        });
      }
      return [...latest.values()];
    } catch (error: unknown) {
      this.logger.error(
        `giavangnet gold price request failed: ${this.describeError(error)}`,
      );
      return [];
    }
  }

  private parseGold(result: { source?: string; data?: unknown }): GoldPrice[] {
    const rows: RawGoldRow[] = Array.isArray(result?.data)
      ? (result.data as RawGoldRow[])
      : [];
    const source = result?.source ?? 'vnstock';

    // The feed repeats each product at several publish times; keep the latest.
    const latest = new Map<string, { row: RawGoldRow; at: number }>();
    for (const row of rows) {
      const name = row.name?.trim();
      if (!name) continue;
      const at = this.parseTimestamp(row.updatedAt);
      const key = name.toUpperCase();
      const seen = latest.get(key);
      if (!seen || at > seen.at) latest.set(key, { row, at });
    }

    const results: GoldPrice[] = [];
    for (const { row, at } of latest.values()) {
      const buyPrice = this.parseAmount(row.buyPrice);
      const sellPrice = this.parseAmount(row.sellPrice);
      // A row with neither side priced carries no information.
      if (buyPrice === null && sellPrice === null) continue;
      const { name, brand } = this.splitName(row.name ?? '');
      results.push({
        name,
        brand,
        karat: row.karat?.trim() ?? '',
        fineness: row.weight?.trim() ?? '',
        buyPrice: buyPrice ?? 0,
        sellPrice,
        priceTime: new Date(at).toISOString(),
        source,
      });
    }
    return results;
  }

  async getFxCounterRates(): Promise<FxCounterRate[]> {
    this.ratesInFlight ??= this.withTimeout(
      commodity.exchange(),
      'exchange rates',
    )
      .then((result) => {
        const parsed = this.parseRates(Array.isArray(result) ? result : []);
        if (parsed.length > 0) this.lastRates = parsed;
        return parsed;
      })
      .catch((error: unknown) => {
        this.logger.error(
          `vnstock exchange rate request failed: ${this.describeError(error)}`,
        );
        return this.lastRates;
      })
      .finally(() => {
        this.ratesInFlight = undefined;
      });
    return this.ratesInFlight;
  }

  private parseRates(rows: RawExchangeRow[]): FxCounterRate[] {
    const results: FxCounterRate[] = [];
    for (const row of rows) {
      const currencyCode = row.currencyCode?.trim().toUpperCase();
      if (!currencyCode) continue;
      const buyCash = this.parseAmount(row.buyCash);
      const buyTransfer = this.parseAmount(row.buyTransfer);
      const sell = this.parseAmount(row.sell);
      // Every leg unquoted → the bank does not deal in that currency today.
      if (buyCash === null && buyTransfer === null && sell === null) continue;
      results.push({
        currencyCode,
        currencyName: row.currencyName?.trim() ?? currencyCode,
        buyCash,
        buyTransfer,
        sell,
        source: 'vnstock',
      });
    }
    return results;
  }

  /**
   * vnstock wraps upstream failures, so `message` alone is often just
   * "Network error". The `cause` it attaches carries the transport code and
   * HTTP status that say whether the feed refused us or never answered.
   */
  private describeError(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const cause = (error as { cause?: Partial<UpstreamCause> }).cause;
    const detail = cause
      ? [
          cause.code ? `code=${cause.code}` : '',
          cause.status ? `status=${cause.status}` : '',
          cause.url ? `url=${cause.url}` : '',
        ]
          .filter(Boolean)
          .join(' ')
      : '';
    return `${error.name}: ${error.message}${detail ? ` (${detail})` : ''}`;
  }

  /** An unquoted leg arrives as `0`; surface it as `null`, never as free. */
  private parseAmount(raw?: string | number): number | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const value = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** `"NHẪN TRÒN TRƠN (Vàng Rồng Thăng Long)"` → product + brand. */
  private splitName(raw: string): { name: string; brand: string } {
    const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(raw.trim());
    if (!match) return { name: raw.trim(), brand: '' };
    return { name: match[1].trim(), brand: match[2].trim() };
  }

  /** giavang.net publishes `update_time` as unix seconds. Falls back to now. */
  private parseEpoch(raw?: string | number): string {
    const seconds = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0)
      return new Date().toISOString();
    return new Date(seconds * 1000).toISOString();
  }

  /** `DD/MM/YYYY HH:mm` in UTC+7; `new Date()` cannot parse it. Falls back to now. */
  private parseTimestamp(raw?: string): number {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(
      raw?.trim() ?? '',
    );
    if (!match) return Date.now();
    const [, day, month, year, hour = '0', minute = '0'] = match;
    const utc = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
    );
    // Vietnam is UTC+7 year-round (no DST).
    return utc - 7 * 60 * 60 * 1000;
  }
}

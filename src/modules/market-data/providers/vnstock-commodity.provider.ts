import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { commodity } from 'vnstock-js';
import type { FxCounterRate } from '../entities/fx-rate.entity';
import type { GoldPrice } from '../entities/gold-price.entity';
import type { CommodityProvider } from './commodity-provider.interface';

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
 * giavang.net `type_code` → the product it quotes. Every retail row is listed
 * as its own product: the feed's value is the per-dealer spread, and collapsing
 * several dealers onto one name threw most of the list away.
 *
 * The first three names are inherited from the retired BTMC feed and must not
 * be renamed — stored assets reference them. Index codes (XAUUSD, USDX) are
 * deliberately absent: they are not retail products.
 */
const GIAVANGNET_PRODUCTS: Readonly<
  Record<string, { name: string; brand: string }>
> = {
  // Inherited from BTMC; renaming these orphans existing assets.
  BTSJC: { name: 'VÀNG MIẾNG SJC', brand: 'Vàng SJC' },
  BT9999NTT: { name: 'NHẪN TRÒN TRƠN', brand: 'Vàng Rồng Thăng Long' },
  DOJINHTV: { name: 'VÀNG MIẾNG VRTL', brand: 'Vàng Rồng Thăng Long' },
  // Per-dealer products; the spread differs meaningfully between them.
  SJL1L10: { name: 'VÀNG MIẾNG SJC 1L-10L', brand: 'Vàng SJC' },
  VNGSJC: { name: 'VÀNG MIẾNG SJC (PNJ)', brand: 'PNJ' },
  VIETTINMSJC: { name: 'VÀNG MIẾNG SJC (VietinBank)', brand: 'VietinBank' },
  SJ9999: { name: 'VÀNG SJC 9999', brand: 'Vàng SJC' },
  DOHCML: { name: 'VÀNG MIẾNG DOJI HCM', brand: 'DOJI' },
  DOHNL: { name: 'VÀNG MIẾNG DOJI HÀ NỘI', brand: 'DOJI' },
  PQHNVM: { name: 'VÀNG MIẾNG PHÚ QUÝ', brand: 'Phú Quý' },
  PQHN24NTT: { name: 'NHẪN TRÒN TRƠN PHÚ QUÝ', brand: 'Phú Quý' },
};

/**
 * A giavang.net row older than this is a delisted product the feed still
 * carries (VNGN last moved 2025-05-07). Stamping it "now" would publish a
 * 15-month-old price as today's. Overridable via `COMMODITY_MAX_ROW_AGE_DAYS`.
 */
const MAX_ROW_AGE_MS =
  Number(process.env.COMMODITY_MAX_ROW_AGE_DAYS ?? 7) * 24 * 60 * 60 * 1000;

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
   * giavang.net is the only gold feed. BTMC was dropped 2026-08-27: plain HTTP
   * on port 80, it truncated or timed out from outside Vietnam and contributed
   * nothing in production. See memory/market-data.md.
   */
  private async fetchGold(): Promise<GoldPrice[]> {
    const prices = await this.fetchGoldFromGiaVangNet();
    if (prices.length > 0) {
      this.lastGold = prices;
      return prices;
    }
    // A partial list is worse than a stale one: it silently drops products the
    // user holds, so both the symbol list and the quote go missing.
    return this.lastGold;
  }

  /** Union by product name; the earlier list wins a contested product. */
  private merge(...lists: GoldPrice[][]): GoldPrice[] {
    const merged = new Map<string, GoldPrice>();
    for (const price of lists.flat()) {
      const key = price.name.trim().toUpperCase();
      if (!key || merged.has(key)) continue;
      merged.set(key, price);
    }
    return [...merged.values()];
  }

  /**
   * Its rows are keyed by `type_code` and carry no product name (every row
   * sends `type: "GOLD"`), so each code is mapped onto a product.
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
        // The feed still carries delisted products at their last-ever price.
        const at = this.parseEpoch(row.updatedAt);
        if (at === null || Date.now() - at > MAX_ROW_AGE_MS) continue;
        // Several codes quote the same product; the first mapped one wins.
        if (latest.has(product.name)) continue;
        latest.set(product.name, {
          name: product.name,
          brand: product.brand,
          karat: '',
          fineness: '',
          buyPrice: buyPrice ?? 0,
          sellPrice,
          priceTime: new Date(at).toISOString(),
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

  /**
   * giavang.net sends either `YYYY-MM-DD` or unix seconds. Returns null when
   * unparseable, so a bad stamp is never silently published as "now".
   */
  private parseEpoch(raw?: string | number): number | null {
    if (typeof raw === 'string') {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
      // Dates are Vietnamese calendar days; anchor to UTC+7, not UTC.
      if (match)
        return (
          Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) -
          7 * 60 * 60 * 1000
        );
    }
    const seconds = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds * 1000;
  }
}

import { Injectable, Logger } from '@nestjs/common';
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
@Injectable()
export class VnstockCommodityProvider implements CommodityProvider {
  private readonly logger = new Logger(VnstockCommodityProvider.name);

  async getGoldPrices(): Promise<GoldPrice[]> {
    let result: { source?: string; data?: unknown };
    try {
      result = await commodity.gold.price();
    } catch (error) {
      this.logger.error(
        `vnstock gold price request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }

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
    let rows: RawExchangeRow[];
    try {
      const result = await commodity.exchange();
      rows = Array.isArray(result) ? result : [];
    } catch (error) {
      this.logger.error(
        `vnstock exchange rate request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }

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

import { Injectable } from '@nestjs/common';
import type { SymbolReference } from '../entities/symbol-reference.entity';
import type { GoldPrice } from '../entities/gold-price.entity';
import { COMMODITY_PROVIDER } from './commodity-provider.interface';
import type { CommodityProvider } from './commodity-provider.interface';
import { Inject } from '@nestjs/common';
import type {
  SymbolAssetClass,
  SymbolReferenceProvider,
} from './symbol-reference-provider.interface';

const REFERENCE_TTL_MS = 60 * 60 * 1000; // 1h — dealer product lists are stable.

/** Currencies offered; each must be quoted by the counter-rate feed. */
const SUPPORTED_CURRENCIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'USD', name: 'Đô la Mỹ' },
  { code: 'JPY', name: 'Yên Nhật' },
];

/** Gold products offered, in display order. Allowlisted; see memory/market-data.md. */
const GOLD_PRODUCTS: readonly string[] = [
  'VÀNG MIẾNG SJC',
  'NHẪN TRÒN TRƠN',
  'VÀNG MIẾNG VRTL',
  'QUÀ MỪNG BẢN VỊ VÀNG',
  'TRANG SỨC VÀNG RỒNG THĂNG LONG 999.9',
  'TRANG SỨC VÀNG RỒNG THĂNG LONG 99.9',
  // Per-dealer products only giavang.net quotes.
  'VÀNG MIẾNG SJC 1L-10L',
  'VÀNG MIẾNG SJC (PNJ)',
  'VÀNG MIẾNG SJC (VietinBank)',
  'VÀNG SJC 9999',
  'VÀNG MIẾNG DOJI HCM',
  'VÀNG MIẾNG DOJI HÀ NỘI',
  'VÀNG MIẾNG PHÚ QUÝ',
  'NHẪN TRÒN TRƠN PHÚ QUÝ',
];

/**
 * Silver still shares the `gold` class, but no feed supplies it since BTMC was
 * dropped. Kept so a household holding silver keeps resolving if a source
 * returns. See memory/market-data.md.
 */
const SILVER_MARKER = /\bB[ẠA]C\b/i;

/**
 * Reference lists for gold/silver and foreign currency, derived from the live
 * commodity feed so every listed item is one the price feed can quote.
 */
@Injectable()
export class VnstockCommoditySymbolReferenceProvider implements SymbolReferenceProvider {
  private readonly cache = new Map<
    SymbolAssetClass,
    { value: SymbolReference[]; expiresAt: number }
  >();

  constructor(
    @Inject(COMMODITY_PROVIDER)
    private readonly commodityProvider: CommodityProvider,
  ) {}

  async listSymbols(assetClass: SymbolAssetClass): Promise<SymbolReference[]> {
    if (assetClass !== 'gold' && assetClass !== 'foreign_currency') return [];

    const entry = this.cache.get(assetClass);
    if (entry && Date.now() < entry.expiresAt) return entry.value;

    const value =
      assetClass === 'gold'
        ? await this.listGold()
        : await this.listCurrencies();

    // Never cache an empty list — it is the "upstream unavailable" signal.
    if (value.length === 0) return entry?.value ?? [];
    this.cache.set(assetClass, {
      value,
      expiresAt: Date.now() + REFERENCE_TTL_MS,
    });
    return value;
  }

  /** Allowlisted gold first, then any silver a feed supplies. Name IS the symbol. */
  private async listGold(): Promise<SymbolReference[]> {
    const prices = await this.commodityProvider.getGoldPrices();
    const byName = new Map(
      prices.map((price) => [price.name.trim().toUpperCase(), price]),
    );

    const result: SymbolReference[] = [];
    const seen = new Set<string>();

    const push = (price: GoldPrice) => {
      const symbol = price.name.trim();
      if (!symbol || seen.has(symbol.toUpperCase())) return;
      seen.add(symbol.toUpperCase());
      result.push({
        assetClass: 'gold',
        symbol,
        name: price.brand ? `${symbol} — ${price.brand}` : symbol,
        exchange: price.brand,
        currency: 'VND',
        // Dealers quote per lượng; the form's unit picker can still override.
        unit: 'lượng',
      });
    };

    for (const product of GOLD_PRODUCTS) {
      const price = byName.get(product.toUpperCase());
      if (price) push(price);
    }
    for (const price of prices) {
      if (SILVER_MARKER.test(price.name)) push(price);
    }
    return result;
  }

  /** The supported currencies the bank actually quotes today. */
  private async listCurrencies(): Promise<SymbolReference[]> {
    const rates = await this.commodityProvider.getFxCounterRates();
    const quoted = new Map(rates.map((rate) => [rate.currencyCode, rate]));
    const result: SymbolReference[] = [];
    for (const { code, name } of SUPPORTED_CURRENCIES) {
      const rate = quoted.get(code);
      if (!rate) continue;
      result.push({
        assetClass: 'foreign_currency',
        symbol: code,
        name: `${name} (${rate.currencyName})`,
        exchange: '',
        currency: 'VND',
        unit: code,
      });
    }
    return result;
  }
}

/**
 * One gold product quoted by a Vietnamese dealer.
 *
 * Prices are **VND per lượng** (the unit Vietnamese dealers quote in — 1 lượng
 * = 10 chỉ ≈ 37.5g), matching how the seed data and the asset valuation flow
 * already express gold. They are plain numbers, not the upstream strings.
 */
export interface GoldPrice {
  /** Product name as the dealer publishes it, e.g. "VÀNG MIẾNG SJC". */
  name: string;
  /** Dealer/brand the quote came from, e.g. "Vàng SJC", "Vàng Rồng Thăng Long". */
  brand: string;
  /** Purity as published, e.g. "24k". */
  karat: string;
  /** Fineness as published, e.g. "999.9". */
  fineness: string;
  /** What the dealer pays to buy gold from you, VND per lượng. */
  buyPrice: number;
  /**
   * What the dealer charges to sell gold to you, VND per lượng, or `null` when
   * the dealer does not sell that product — upstream reports this as `0`, which
   * must never be shown as a free price.
   */
  sellPrice: number | null;
  /** When the dealer last updated the quote (ISO-8601). */
  priceTime: string;
  /** Upstream that supplied the quote, e.g. `btmc`. */
  source: string;
}

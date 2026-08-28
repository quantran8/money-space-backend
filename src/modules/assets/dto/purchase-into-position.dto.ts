/**
 * Buying more of a position the household already holds.
 *
 * Until this existed, the only way to add to a holding was to type a bigger
 * number into the asset edit form — which moved no money, left no event, and
 * priced the whole enlarged position at the old cost basis. This makes the act
 * a purchase: the wallet pays, and the cost basis is re-averaged.
 */
export interface PurchaseIntoPositionDto {
  /** How much was added, in the position's own unit (chỉ, cổ phiếu, BTC…). */
  quantity: number;
  /**
   * Price paid per unit. Folded into the position's weighted-average
   * `purchasePrice`, which is what P&L is measured against — so buying at a
   * higher price correctly raises the average rather than pretending the whole
   * holding was bought at the old one.
   */
  purchasePrice: number;
  /**
   * The wallet that paid. Omitting it means the quantity arrived without the
   * household spending anything (a gift, a stock dividend): the event is still
   * recorded, but no balance is debited and net worth rises.
   */
  fundingAssetId?: string | null;
}

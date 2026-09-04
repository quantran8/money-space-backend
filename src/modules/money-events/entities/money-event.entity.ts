export type MoneyEventType =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'asset_purchase'
  | 'asset_sale'
  // A revaluation: the user re-priced an asset directly (manualValue, lastPrice,
  // term…). `neutral` — records why the value changed for history, but moves no
  // wallet and is excluded from income/expense reports. See [[asset-valuation]].
  //
  // `quantity` used to be on that list, and that was the bug: a changed holding
  // was written as a price movement, so correcting 10 chỉ to 1 chỉ reported a
  // loss the household never took. Quantity now has its own type below.
  | 'asset_update'
  // A quantity change that is neither a purchase nor a sale — a corrected
  // holding, a recount. Neutral like `asset_update` and excluded from the same
  // reports, but distinct from it: this one says the QUANTITY moved, not the
  // price. `quantityBefore`/`quantityAfter` carry both sides.
  | 'asset_quantity_adjustment'
  // Settling a cashflow event (an outgoing one marked done). Present in the DB
  // enum and written by `completeCashflowEvent`; it was missing from this union,
  // which an `as never` cast at the call site hid.
  | 'payment_paid'
  | 'debt_update'
  | 'adjustment'
  // Present in the DB enum and reachable through the money-events API, which
  // does not validate `type` against an allowlist. It was missing here.
  | 'other';

export type MoneyDirection = 'inflow' | 'outflow' | 'neutral';

export interface MoneyEvent {
  id: string;
  householdId: string;
  amount: number;
  /** Sale/purchase fee. 0 for every other event type. See asset-sale.md. */
  feeAmount: number;
  /**
   * Resolved sold quantity (market assets) / value (manual assets) for an
   * asset_sale, so an edit/cancel can restore the position exactly. Undefined
   * for non-sale events.
   */
  soldQuantity?: number;
  soldValue?: number;
  /**
   * The position held either side of an event that MOVES quantity (a quantity
   * adjustment, and any purchase/sale that should be replayable). Undefined for
   * events that move no position. Together they let the quantity series be
   * rebuilt without assuming which event types can change a holding — the
   * assumption `buildMarketValueHistory` still makes today.
   */
  quantityBefore?: number;
  quantityAfter?: number;
  note: string;
  isoDate: string;
  type: MoneyEventType;
  /** FK to `money_event_categories.id` (was a free code string). */
  categoryId: string;
  direction: MoneyDirection;
  fromAssetId?: string;
  toAssetId?: string;
  upcomingPaymentId?: string;
  debtId?: string;
  /**
   * Profile id of whoever recorded the event (`money_events.created_by`, NOT
   * NULL). Distinct from the privacy owner. Clients resolve it against the
   * household's members to name the person; a creator who has since left the
   * household resolves to nothing and the row falls back to the household.
   */
  createdById?: string;
}

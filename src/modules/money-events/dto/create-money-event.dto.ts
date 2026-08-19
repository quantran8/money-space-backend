import type {
  MoneyDirection,
  MoneyEventType,
} from '../entities/money-event.entity';

export interface CreateMoneyEventDto {
  amount: number;
  /** Sale/purchase fee. Defaults to 0. See asset-sale.md. */
  feeAmount?: number;
  /** For an asset_sale: resolved sold quantity (market) / value (manual). */
  soldQuantity?: number;
  soldValue?: number;
  note?: string;
  isoDate: string;
  type: MoneyEventType;
  category: string;
  direction?: MoneyDirection;
  fromAssetId?: string;
  toAssetId?: string;
  /**
   * The cashflow event this money event settles (column `cashflow_event_id`).
   *
   * `upcomingPaymentId` is the pre-rename spelling, kept so existing callers
   * keep working. Prefer `cashflowEventId`; when both are set it wins.
   */
  cashflowEventId?: string;
  /** @deprecated Use {@link cashflowEventId}. */
  upcomingPaymentId?: string;
  debtId?: string;
}

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
  upcomingPaymentId?: string;
  debtId?: string;
  financialGoalId?: string;
}

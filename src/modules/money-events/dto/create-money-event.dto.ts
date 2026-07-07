import type {
  MoneyDirection,
  MoneyEventType,
} from '../entities/money-event.entity';

export interface CreateMoneyEventDto {
  title: string;
  amount: number;
  note?: string;
  isoDate: string;
  type: MoneyEventType;
  category: string;
  direction?: MoneyDirection;
  fromAssetId?: string;
  toAssetId?: string;
  upcomingPaymentId?: string;
  financialGoalId?: string;
}

import type { RecurrenceFrequency } from '../../../common/utils/recurrence';
import type {
  AttentionLevel,
  CashflowCertainty,
  CashflowDirection,
} from '../entities/cashflow-event.entity';

export interface CreateCashflowEventDto {
  name: string;
  /** FK to `money_event_categories.id`. Falls back to the system `other`
   *  category when omitted. */
  categoryId?: string;
  amount: number;
  direction: CashflowDirection;
  expectedDate: string;
  recurrence?: RecurrenceFrequency;
  recurrenceEndDate?: string | null;
  /**
   * Outgoing only. Defaults to `required` when omitted; forced to `null` for
   * incoming (§18 validation).
   */
  requirement?: 'required' | 'planned';
  certainty?: CashflowCertainty;
  ownerMemberId?: string | null;
  debtId?: string | null;
  financialGoalId?: string | null;
  plannedAssetId?: string | null;
  /** Optional wallet this event will settle through. See the entity field. */
  settlementAssetId?: string | null;
  attentionLevel?: AttentionLevel;
  note?: string;
}

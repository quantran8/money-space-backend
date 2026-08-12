import type { RecurrenceFrequency } from '../../../common/utils/recurrence';
import type { VisibilityLevel } from '../../../common/utils/money-space.utils';
import type {
  AttentionLevel,
  CashflowCertainty,
  CashflowDirection,
} from '../entities/cashflow-event.entity';

export interface CreateCashflowEventDto {
  name: string;
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
  /** Required when `visibilityLevel` is `private` (§30). */
  privacyOwnerMemberId?: string | null;
  debtId?: string | null;
  financialGoalId?: string | null;
  plannedAssetId?: string | null;
  attentionLevel?: AttentionLevel;
  visibilityLevel?: VisibilityLevel;
  note?: string;
}

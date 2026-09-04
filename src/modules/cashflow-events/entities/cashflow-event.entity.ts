import type { RecurrenceFrequency } from '../../../common/utils/recurrence';

/** Which way the money moves. */
export type CashflowDirection = 'incoming' | 'outgoing';

/**
 * Whether an outgoing event is an obligation or a choice.
 *
 * Only `required` counts toward obligation coverage — `planned` money still
 * leaves the account (so it affects the running balance) but failing to spend
 * it does not mean the household is "not covered". `null` for incoming: you
 * don't "have to" receive money.
 */
export type CashflowRequirement = 'required' | 'planned' | null;

/**
 * How sure the amount/date is. The forecast banks only `confirmed` incoming;
 * `estimated` is displayed but must never be silently treated as certain
 * (spec §26A.5) — that is what keeps the forecast conservative.
 */
export type CashflowCertainty = 'confirmed' | 'estimated';

export type CashflowEventStatus =
  | 'expected'
  | 'completed'
  | 'pending_confirmation'
  | 'postponed'
  | 'overdue'
  | 'cancelled';

export type AttentionLevel = 'normal' | 'important' | 'urgent';

/**
 * One expected future movement of money — the sole input to the forecast
 * (spec §18). Replaces `UpcomingPayment`, which could only express money going
 * out and therefore could not produce a running balance.
 *
 * A recurring event is ONE record: `expectedDate` is the current occurrence and
 * `recurrence` is the rule. The forecast expands future occurrences virtually
 * and completing one advances `expectedDate` — occurrence rows are never
 * pre-created (§2.15).
 */
export interface CashflowEvent {
  id: string;
  householdId: string;
  name: string;
  /** FK to `money_event_categories.id`, same as `money_events.category_id`.
   *  Completing the event carries it onto the money event it records. */
  categoryId: string;
  amount: number;
  direction: CashflowDirection;
  /** The CURRENT occurrence's date, not the series start. */
  expectedDate: string;
  recurrence: RecurrenceFrequency;
  recurrenceEndDate?: string | null;
  requirement: CashflowRequirement;
  certainty: CashflowCertainty;
  status: CashflowEventStatus;
  attentionLevel: AttentionLevel;
  ownerMemberId?: string | null;
  debtId?: string | null;
  financialGoalId?: string | null;
  /** The asset this event is earmarked to buy/fund, when known. */
  plannedAssetId?: string | null;
  /**
   * The wallet this event is expected to move through — debited when outgoing,
   * credited when incoming. Optional at planning time; completing the event
   * falls back to it and requires a wallet when it is null. Must be a
   * `usable_now` wallet asset (`cash` / `bank_account`).
   */
  settlementAssetId?: string | null;
  note?: string;
  // For a RECURRING series these describe the most recent completion, not a
  // terminal state — the record lives on and `expectedDate` moves forward.
  lastCompletedAt?: string | null;
  lastCompletedById?: string | null;
  lastCompletedAmount?: number | null;
  lastCompletedAssetId?: string | null;
}

/**
 * Statuses that still owe money — the ones the forecast must count.
 * `postponed` is deliberately excluded: it is shown on the timeline but its
 * date is no longer trusted, so it must not move the balance.
 */
export const LIVE_CASHFLOW_STATUSES: readonly CashflowEventStatus[] = [
  'expected',
  'pending_confirmation',
  'overdue',
];

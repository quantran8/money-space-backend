import { addDaysIso, type IsoDate } from '../../../common/utils/clock';
import { nextOccurrenceAfter } from '../../../common/utils/recurrence';
import type {
  CashflowDirection,
  CashflowEvent,
} from '../entities/cashflow-event.entity';

// See memory/cashflow-settlement.md.
export type SettledVia = 'manual_complete' | 'manual_link' | 'auto_note';

export interface SettlementEvidence {
  moneyEventId: string;
  occurrenceDate: IsoDate;
  amount: number;
  assetId: string | null;
  settledAt: string;
  settledById: string | null;
  settledVia: SettledVia;
  notificationEventId: string | null;
}

export interface SettleFacts {
  amount: number;
  assetId: string | null;
  settledAt: string;
  settledById: string | null;
}

/** Settle the occurrence on `expectedDate`; one-off closes, a series advances. */
export function advanceAfterSettlement(
  event: CashflowEvent,
  facts: SettleFacts,
): CashflowEvent {
  const advancedTo = nextOccurrenceAfter(event.expectedDate, event.recurrence);
  const seriesFinished =
    advancedTo !== null &&
    event.recurrenceEndDate != null &&
    advancedTo > event.recurrenceEndDate;
  const keepsRunning = advancedTo !== null && !seriesFinished;

  return {
    ...event,
    status: keepsRunning ? 'expected' : 'completed',
    expectedDate: keepsRunning ? advancedTo : event.expectedDate,
    lastCompletedAt: facts.settledAt,
    lastCompletedById: facts.settledById,
    lastCompletedAmount: facts.amount,
    lastCompletedAssetId: facts.assetId,
  };
}

/** Re-open `occurrenceDate`; `remaining` is the newest evidence left, if any. */
export function revertSettlement(
  event: CashflowEvent,
  occurrenceDate: IsoDate,
  remaining: SettlementEvidence | null,
): CashflowEvent {
  return {
    ...event,
    status: 'expected',
    expectedDate: occurrenceDate,
    lastCompletedAt: remaining?.settledAt ?? null,
    lastCompletedById: remaining?.settledById ?? null,
    lastCompletedAmount: remaining?.amount ?? null,
    lastCompletedAssetId: remaining?.assetId ?? null,
  };
}

export function directionMatches(
  direction: CashflowDirection,
  moneyDirection: string,
): boolean {
  return direction === 'incoming'
    ? moneyDirection === 'inflow'
    : moneyDirection === 'outflow';
}

/** Evidence sorted newest occurrence first. */
export function isLatestSettlement(
  settlements: readonly SettlementEvidence[],
  moneyEventId: string,
): boolean {
  return settlements[0]?.moneyEventId === moneyEventId;
}

export interface OccurrenceWindow {
  from: IsoDate;
  /** Exclusive; null for a one-off. */
  until: IsoDate | null;
}

export function occurrenceWindow(
  event: Pick<CashflowEvent, 'recurrence' | 'recurrenceEndDate'>,
  occurrenceDate: IsoDate,
): OccurrenceWindow {
  const leadDays = event.recurrence === 'weekly' ? 3 : 10;
  const next = nextOccurrenceAfter(occurrenceDate, event.recurrence);
  const lastOne =
    next !== null &&
    event.recurrenceEndDate != null &&
    next > event.recurrenceEndDate;
  return {
    from: addDaysIso(occurrenceDate, -leadDays),
    until: lastOne ? null : next,
  };
}

import type { IsoDate } from '../../../common/utils/clock';
import type { CashflowEvent } from '../entities/cashflow-event.entity';
import { normalizeNote, phraseMatches } from './note-normalize';
import { occurrenceWindow } from './settlement';

// Note-only auto-match. See memory/cashflow-settlement.md.
export type MatchStatus =
  'none' | 'matched' | 'ambiguous' | 'blocked' | 'replace_manual';

export interface MatchRuleView {
  id: string;
  cashflowEventId: string;
  phraseNormalized: string;
}

export interface MatchTarget {
  event: CashflowEvent;
  /** Newest settlement, when it was a manual completion with no bank evidence. */
  latestManual: { moneyEventId: string; occurrenceDate: IsoDate } | null;
}

export interface MatchInput {
  note: string | null;
  direction: 'IN' | 'OUT';
  walletId: string;
  txDate: IsoDate;
  rules: readonly MatchRuleView[];
  targets: ReadonlyMap<string, MatchTarget>;
}

export interface MatchResult {
  status: MatchStatus;
  reason: string;
  cashflowEventId?: string;
  ruleId?: string;
  replaceMoneyEventId?: string;
}

const OPEN_STATUSES = new Set(['expected', 'overdue', 'pending_confirmation']);

function inWindow(txDate: IsoDate, from: IsoDate, until: IsoDate | null) {
  return txDate >= from && (until === null || txDate < until);
}

export function matchByNote(input: MatchInput): MatchResult {
  const note = normalizeNote(input.note);
  if (!note) return { status: 'none', reason: 'EMPTY_NOTE' };

  const hits = input.rules.filter(
    (rule) =>
      input.targets.has(rule.cashflowEventId) &&
      phraseMatches(note, rule.phraseNormalized),
  );
  const eventIds = [...new Set(hits.map((rule) => rule.cashflowEventId))];
  if (eventIds.length === 0) return { status: 'none', reason: 'NO_RULE' };
  if (eventIds.length > 1) {
    return { status: 'ambiguous', reason: 'MULTIPLE_EVENTS' };
  }

  const cashflowEventId = eventIds[0];
  const ruleId = hits[0].id;
  const { event, latestManual } = input.targets.get(cashflowEventId)!;
  const base = { cashflowEventId, ruleId };

  const expectedDirection = input.direction === 'IN' ? 'incoming' : 'outgoing';
  if (event.direction !== expectedDirection) {
    return { ...base, status: 'blocked', reason: 'DIRECTION' };
  }
  if (event.settlementAssetId && event.settlementAssetId !== input.walletId) {
    return { ...base, status: 'blocked', reason: 'WALLET' };
  }

  if (latestManual) {
    const window = occurrenceWindow(event, latestManual.occurrenceDate);
    if (inWindow(input.txDate, window.from, window.until)) {
      return {
        ...base,
        status: 'replace_manual',
        reason: 'MANUAL_ALREADY_COMPLETED',
        replaceMoneyEventId: latestManual.moneyEventId,
      };
    }
  }

  if (!OPEN_STATUSES.has(event.status)) {
    return { ...base, status: 'blocked', reason: 'STATUS' };
  }

  const window = occurrenceWindow(event, event.expectedDate);
  if (input.txDate < window.from) {
    return { ...base, status: 'none', reason: 'BEFORE_WINDOW' };
  }
  if (window.until !== null && input.txDate >= window.until) {
    return { ...base, status: 'ambiguous', reason: 'MULTIPLE_PERIODS' };
  }
  return { ...base, status: 'matched', reason: 'NOTE_RULE' };
}

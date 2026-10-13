import type { CashflowEvent } from '../entities/cashflow-event.entity';
import {
  advanceAfterSettlement,
  directionMatches,
  occurrenceWindow,
  revertSettlement,
} from './settlement';

const M = 1_000_000;

function event(over: Partial<CashflowEvent> = {}): CashflowEvent {
  return {
    id: 'cf-1',
    householdId: 'hh-1',
    name: 'Luong',
    categoryId: 'cat',
    amount: 30 * M,
    direction: 'incoming',
    expectedDate: '2026-10-25',
    recurrence: 'monthly',
    recurrenceEndDate: null,
    requirement: null,
    certainty: 'confirmed',
    status: 'expected',
    attentionLevel: 'normal',
    lastCompletedAt: null,
    lastCompletedById: null,
    lastCompletedAmount: null,
    lastCompletedAssetId: null,
    ...over,
  };
}

const facts = {
  amount: 32 * M,
  assetId: 'w-1',
  settledAt: '2026-10-25T03:00:00.000Z',
  settledById: 'u-1',
};

describe('advanceAfterSettlement', () => {
  it('advances a series and keeps the expected amount for the next period', () => {
    const next = advanceAfterSettlement(event(), facts);
    expect(next.expectedDate).toBe('2026-11-25');
    expect(next.status).toBe('expected');
    expect(next.amount).toBe(30 * M);
    expect(next.lastCompletedAmount).toBe(32 * M);
    expect(next.lastCompletedById).toBe('u-1');
  });

  it('closes a one-off', () => {
    const next = advanceAfterSettlement(event({ recurrence: 'once' }), facts);
    expect(next.status).toBe('completed');
    expect(next.expectedDate).toBe('2026-10-25');
  });

  it('closes a series past its end date', () => {
    const next = advanceAfterSettlement(
      event({ recurrenceEndDate: '2026-11-01' }),
      facts,
    );
    expect(next.status).toBe('completed');
  });
});

describe('revertSettlement', () => {
  it('re-opens the occurrence and restores the previous completion', () => {
    const settled = advanceAfterSettlement(event(), facts);
    const reverted = revertSettlement(settled, '2026-10-25', {
      moneyEventId: 'me-0',
      occurrenceDate: '2026-09-25',
      amount: 30 * M,
      assetId: 'w-1',
      settledAt: '2026-09-25T03:00:00.000Z',
      settledById: 'u-2',
      settledVia: 'manual_complete',
      notificationEventId: null,
    });
    expect(reverted.expectedDate).toBe('2026-10-25');
    expect(reverted.status).toBe('expected');
    expect(reverted.lastCompletedById).toBe('u-2');
  });

  it('clears completion fields when nothing remains', () => {
    const reverted = revertSettlement(
      advanceAfterSettlement(event({ recurrence: 'once' }), facts),
      '2026-10-25',
      null,
    );
    expect(reverted.status).toBe('expected');
    expect(reverted.lastCompletedAt).toBeNull();
  });
});

describe('directionMatches', () => {
  it('pairs incoming with inflow and outgoing with outflow only', () => {
    expect(directionMatches('incoming', 'inflow')).toBe(true);
    expect(directionMatches('incoming', 'outflow')).toBe(false);
    expect(directionMatches('outgoing', 'outflow')).toBe(true);
    expect(directionMatches('outgoing', 'neutral')).toBe(false);
  });
});

describe('occurrenceWindow', () => {
  it('opens 10 days early and closes at the next occurrence', () => {
    expect(occurrenceWindow(event(), '2026-10-25')).toEqual({
      from: '2026-10-15',
      until: '2026-11-25',
    });
  });

  it('is open-ended for a one-off and for the last occurrence', () => {
    expect(
      occurrenceWindow(event({ recurrence: 'once' }), '2026-10-25').until,
    ).toBeNull();
    expect(
      occurrenceWindow(event({ recurrenceEndDate: '2026-11-01' }), '2026-10-25')
        .until,
    ).toBeNull();
  });
});

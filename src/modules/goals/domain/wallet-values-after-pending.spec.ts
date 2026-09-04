import { walletValuesAfterPendingOutflows } from './wallet-values-after-pending';
import type { CashflowEvent } from '../../cashflow-events/entities/cashflow-event.entity';

const M = 1_000_000;
const WALLET = 'wallet-1';

function event(overrides: Partial<CashflowEvent> = {}): CashflowEvent {
  return {
    id: 'evt-1',
    householdId: 'hh-1',
    name: 'bill',
    categoryId: 'cat-other',
    amount: 2 * M,
    direction: 'outgoing',
    expectedDate: '2026-08-31',
    recurrence: 'once',
    requirement: 'required',
    certainty: 'confirmed',
    status: 'expected',
    attentionLevel: 'normal',
    settlementAssetId: WALLET,
    ...overrides,
  };
}

describe('walletValuesAfterPendingOutflows', () => {
  const values = new Map([[WALLET, 28.8 * M]]);

  // The reported case: a 2tr bill scheduled against the wallet a goal saves
  // into. The month's pace must be measured after it, not before.
  it('subtracts a live outgoing event due within the month', () => {
    const result = walletValuesAfterPendingOutflows(
      values,
      [event()],
      '2026-08-31',
    );
    expect(result.get(WALLET)).toBe(26.8 * M);
  });

  it('leaves the map untouched when there are no events', () => {
    expect(walletValuesAfterPendingOutflows(values, [], '2026-08-31')).toEqual(
      values,
    );
  });

  // A bill due in three months has taken nothing away from THIS month's saving.
  it('ignores an event due after the window', () => {
    const result = walletValuesAfterPendingOutflows(
      values,
      [event({ expectedDate: '2026-11-01' })],
      '2026-08-31',
    );
    expect(result.get(WALLET)).toBe(28.8 * M);
  });

  // A completed event already moved the balance; counting it here would charge
  // it twice. `cancelled` and `postponed` must not move it at all.
  it.each(['completed', 'cancelled', 'postponed'] as const)(
    'ignores a %s event',
    (status) => {
      const result = walletValuesAfterPendingOutflows(
        values,
        [event({ status })],
        '2026-08-31',
      );
      expect(result.get(WALLET)).toBe(28.8 * M);
    },
  );

  it.each(['expected', 'pending_confirmation', 'overdue'] as const)(
    'subtracts a %s event',
    (status) => {
      const result = walletValuesAfterPendingOutflows(
        values,
        [event({ status })],
        '2026-08-31',
      );
      expect(result.get(WALLET)).toBe(26.8 * M);
    },
  );

  // Money that has not arrived cannot already be behind a goal.
  it('never credits an incoming event', () => {
    const result = walletValuesAfterPendingOutflows(
      values,
      [event({ direction: 'incoming' })],
      '2026-08-31',
    );
    expect(result.get(WALLET)).toBe(28.8 * M);
  });

  it('ignores an outflow that names no wallet', () => {
    const result = walletValuesAfterPendingOutflows(
      values,
      [event({ settlementAssetId: null })],
      '2026-08-31',
    );
    expect(result.get(WALLET)).toBe(28.8 * M);
  });

  it('ignores an outflow settling from a wallet absent from the map', () => {
    const result = walletValuesAfterPendingOutflows(
      values,
      [event({ settlementAssetId: 'gone' })],
      '2026-08-31',
    );
    expect(result.get(WALLET)).toBe(28.8 * M);
    expect(result.has('gone')).toBe(false);
  });

  // A wallet cannot hold negative money: letting it go negative would make one
  // overdrawn wallet cancel out another's goal backing.
  it('floors a wallet at zero rather than going negative', () => {
    const result = walletValuesAfterPendingOutflows(
      values,
      [event({ amount: 40 * M })],
      '2026-08-31',
    );
    expect(result.get(WALLET)).toBe(0);
  });

  it('accumulates several outflows on the same wallet', () => {
    const result = walletValuesAfterPendingOutflows(
      values,
      [event({ id: 'a' }), event({ id: 'b', amount: 3 * M })],
      '2026-08-31',
    );
    expect(result.get(WALLET)).toBe(23.8 * M);
  });

  it('does not mutate the map it was given', () => {
    const original = new Map([[WALLET, 28.8 * M]]);
    walletValuesAfterPendingOutflows(original, [event()], '2026-08-31');
    expect(original.get(WALLET)).toBe(28.8 * M);
  });
});

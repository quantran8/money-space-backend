import { resolveSpendAftermath } from './spend-aftermath';
import type { CashflowEvent } from '../../cashflow-events/entities/cashflow-event.entity';

const M = 1_000_000;
const WALLET = 'tcb';

function event(overrides: Partial<CashflowEvent> = {}): CashflowEvent {
  return {
    id: 'evt-1',
    householdId: 'hh-1',
    name: 'thi lx',
    categoryId: 'cat-other',
    amount: 4 * M,
    direction: 'outgoing',
    expectedDate: '2026-09-01',
    recurrence: 'once',
    requirement: 'required',
    certainty: 'confirmed',
    status: 'expected',
    attentionLevel: 'normal',
    settlementAssetId: WALLET,
    ...overrides,
  };
}

describe('resolveSpendAftermath', () => {
  // The reported case: the wallet is emptied on 31/08, and a 4tr bill falls due
  // the next day with nothing left to pay it.
  it('flags a later bill the spend leaves unpayable', () => {
    const result = resolveSpendAftermath(
      [event()],
      WALLET,
      0,
      '2026-08-31',
      '2026-09-30',
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      name: 'thi lx',
      amount: -4 * M,
      balanceAfter: -4 * M,
      short: true,
    });
    expect(result.shortfallCount).toBe(1);
    expect(result.lowestBalance).toBe(-4 * M);
  });

  it('reports no shortfall when the wallet still covers what follows', () => {
    const result = resolveSpendAftermath(
      [event()],
      WALLET,
      10 * M,
      '2026-08-31',
      '2026-09-30',
    );

    expect(result.rows[0]).toMatchObject({ balanceAfter: 6 * M, short: false });
    expect(result.shortfallCount).toBe(0);
  });

  // Money arriving before the bill is exactly what makes it payable.
  it('counts incoming events as they land', () => {
    const result = resolveSpendAftermath(
      [
        event({ id: 'salary', name: 'lương', amount: 20 * M, direction: 'incoming', expectedDate: '2026-09-05' }),
        event({ id: 'rent', name: 'tiền nhà', amount: 8 * M, expectedDate: '2026-09-10' }),
      ],
      WALLET,
      0,
      '2026-08-31',
      '2026-09-30',
    );

    expect(result.rows.map((row) => row.balanceAfter)).toEqual([20 * M, 12 * M]);
    expect(result.shortfallCount).toBe(0);
  });

  // A dip that later recovers is still a dip — the household cannot pay a bill
  // with money that arrives afterwards.
  it('keeps a shortfall that a later inflow recovers from', () => {
    const result = resolveSpendAftermath(
      [
        event({ id: 'bill', expectedDate: '2026-09-01' }),
        event({ id: 'salary', amount: 30 * M, direction: 'incoming', expectedDate: '2026-09-05' }),
      ],
      WALLET,
      0,
      '2026-08-31',
      '2026-09-30',
    );

    expect(result.shortfallCount).toBe(1);
    expect(result.lowestBalance).toBe(-4 * M);
    expect(result.rows[1].balanceAfter).toBe(26 * M);
  });

  it('ignores events on or before the spend date', () => {
    const result = resolveSpendAftermath(
      [event({ expectedDate: '2026-08-31' })],
      WALLET,
      0,
      '2026-08-31',
      '2026-09-30',
    );

    expect(result.rows).toHaveLength(0);
  });

  it('ignores events past the horizon', () => {
    const result = resolveSpendAftermath(
      [event({ expectedDate: '2026-12-01' })],
      WALLET,
      0,
      '2026-08-31',
      '2026-09-30',
    );

    expect(result.rows).toHaveLength(0);
  });

  it('ignores another wallet', () => {
    const result = resolveSpendAftermath(
      [event({ settlementAssetId: 'vcb' })],
      WALLET,
      0,
      '2026-08-31',
      '2026-09-30',
    );

    expect(result.rows).toHaveLength(0);
  });

  it.each(['completed', 'cancelled', 'postponed'] as const)(
    'ignores a %s event',
    (status) => {
      const result = resolveSpendAftermath(
        [event({ status })],
        WALLET,
        0,
        '2026-08-31',
        '2026-09-30',
      );

      expect(result.rows).toHaveLength(0);
    },
  );

  // The event under edit is replaced by the amount being typed, so counting it
  // here would charge it twice.
  it('leaves out the event being edited', () => {
    const result = resolveSpendAftermath(
      [event({ id: 'evt-edit' })],
      WALLET,
      0,
      '2026-08-31',
      '2026-09-30',
      'evt-edit',
    );

    expect(result.rows).toHaveLength(0);
  });

  it('walks in date order regardless of input order', () => {
    const result = resolveSpendAftermath(
      [
        event({ id: 'late', amount: 1 * M, expectedDate: '2026-09-20' }),
        event({ id: 'early', amount: 2 * M, expectedDate: '2026-09-02' }),
      ],
      WALLET,
      10 * M,
      '2026-08-31',
      '2026-09-30',
    );

    expect(result.rows.map((row) => row.eventId)).toEqual(['early', 'late']);
    expect(result.rows.map((row) => row.balanceAfter)).toEqual([8 * M, 7 * M]);
  });
});

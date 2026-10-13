import type { CashflowEvent } from '../entities/cashflow-event.entity';
import { matchByNote, type MatchInput, type MatchTarget } from './note-match';

function event(over: Partial<CashflowEvent> = {}): CashflowEvent {
  return {
    id: 'salary',
    householdId: 'hh-1',
    name: 'Luong',
    categoryId: 'cat',
    amount: 30_000_000,
    direction: 'incoming',
    expectedDate: '2026-10-25',
    recurrence: 'monthly',
    recurrenceEndDate: null,
    requirement: null,
    certainty: 'confirmed',
    status: 'expected',
    attentionLevel: 'normal',
    settlementAssetId: 'w-1',
    ...over,
  };
}

function input(
  over: Partial<MatchInput> = {},
  targets: MatchTarget[] = [{ event: event(), latestManual: null }],
): MatchInput {
  return {
    note: 'LUONG T10 CTY ABC chuyen',
    direction: 'IN',
    walletId: 'w-1',
    txDate: '2026-10-25',
    rules: [
      {
        id: 'r-1',
        cashflowEventId: 'salary',
        phraseNormalized: 'LUONG T10 CTY ABC',
      },
    ],
    targets: new Map(targets.map((t) => [t.event.id, t])),
    ...over,
  };
}

describe('matchByNote', () => {
  it('S01: a unique note rule inside the window matches', () => {
    expect(matchByNote(input())).toMatchObject({
      status: 'matched',
      cashflowEventId: 'salary',
      ruleId: 'r-1',
    });
  });

  it('S02: an empty note never matches', () => {
    expect(matchByNote(input({ note: '  ' })).status).toBe('none');
  });

  it('S03: an unclear note does not fall back to amount or date', () => {
    expect(matchByNote(input({ note: 'CK' })).status).toBe('none');
  });

  it('S04: two events hit by the note are ambiguous', () => {
    const rent = event({ id: 'rent', direction: 'incoming' });
    const result = matchByNote(
      input(
        {
          note: 'THANH TOAN',
          rules: [
            {
              id: 'r-1',
              cashflowEventId: 'salary',
              phraseNormalized: 'THANH TOAN',
            },
            {
              id: 'r-2',
              cashflowEventId: 'rent',
              phraseNormalized: 'THANH TOAN',
            },
          ],
        },
        [
          { event: event(), latestManual: null },
          { event: rent, latestManual: null },
        ],
      ),
    );
    expect(result.status).toBe('ambiguous');
  });

  it('blocks a direction or wallet conflict', () => {
    expect(matchByNote(input({ direction: 'OUT' })).reason).toBe('DIRECTION');
    expect(matchByNote(input({ walletId: 'w-2' })).reason).toBe('WALLET');
  });

  it('blocks a postponed event', () => {
    const result = matchByNote(
      input({}, [
        { event: event({ status: 'postponed' }), latestManual: null },
      ]),
    );
    expect(result).toMatchObject({ status: 'blocked', reason: 'STATUS' });
  });

  it('does not match before the window', () => {
    expect(matchByNote(input({ txDate: '2026-10-01' })).status).toBe('none');
  });

  it('is ambiguous once a later period is also due', () => {
    expect(matchByNote(input({ txDate: '2026-11-26' }))).toMatchObject({
      status: 'ambiguous',
      reason: 'MULTIPLE_PERIODS',
    });
  });

  it('S08: proposes replacing a manual completion of the same period', () => {
    const advanced = event({ expectedDate: '2026-11-25' });
    const result = matchByNote(
      input({ txDate: '2026-10-26' }, [
        {
          event: advanced,
          latestManual: {
            moneyEventId: 'me-manual',
            occurrenceDate: '2026-10-25',
          },
        },
      ]),
    );
    expect(result).toMatchObject({
      status: 'replace_manual',
      replaceMoneyEventId: 'me-manual',
    });
  });
});

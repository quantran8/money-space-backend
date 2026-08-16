import { runForecast } from '../../forecast/domain/forecast';
import { computeFlexibleMoney } from '../../forecast/domain/flexible-money';
import type {
  ForecastCashflowEvent,
  ForecastInput,
  ForecastLiquidSource,
} from '../../forecast/domain/forecast.types';
import {
  ATTENTION_THRESHOLDS,
  deriveAttentionItems,
  derivedAttentionId,
} from './attention-rules';

const M = 1_000_000;
const TODAY = '2026-08-13';

function asset(over: Partial<ForecastLiquidSource> = {}): ForecastLiquidSource {
  return {
    assetId: 'a1',
    name: 'VCB',
    value: 50 * M,
    liquidity: 'usable_now',
    financialNature: 'household',
    valueUpdatedAt: TODAY,
    ...over,
  };
}

function event(
  over: Partial<ForecastCashflowEvent> = {},
): ForecastCashflowEvent {
  return {
    id: 'e1',
    name: 'Rent',
    direction: 'outgoing',
    amount: 10 * M,
    expectedDate: TODAY,
    recurrence: 'once',
    recurrenceEndDate: null,
    requirement: 'required',
    certainty: 'confirmed',
    status: 'expected',
    ...over,
  };
}

function derive(
  over: Partial<ForecastInput> = {},
  staleAssets?: { assetId: string; name: string; daysSinceUpdate: number }[],
) {
  const input: ForecastInput = {
    householdId: 'hh-1',
    asOfDate: TODAY,
    horizonDays: 30,
    assets: [asset()],
    cashflowEvents: [],
    ...over,
  };
  const forecast = runForecast(input);
  return deriveAttentionItems({
    asOfDate: TODAY,
    forecast,
    flexible: computeFlexibleMoney(forecast),
    staleAssets,
  });
}

const codes = (items: { ruleCode: string }[]) => items.map((i) => i.ruleCode);

describe('deriveAttentionItems — per-event signals', () => {
  it('raises due-soon for a required outgoing inside the window', () => {
    const items = derive({
      cashflowEvents: [event({ expectedDate: '2026-08-18' })],
    });

    expect(codes(items)).toContain('cashflow_required_due_soon');
    const item = items.find(
      (i) => i.ruleCode === 'cashflow_required_due_soon',
    )!;
    expect(item.params.daysUntil).toBe(5);
    expect(item.relatedObjectId).toBe('e1');
  });

  it('stays quiet for a required outgoing beyond the due-soon window', () => {
    const items = derive({
      cashflowEvents: [event({ expectedDate: '2026-08-30' })],
    });
    expect(codes(items)).not.toContain('cashflow_required_due_soon');
  });

  /**
   * A `planned` purchase is a choice. Treating it like an obligation would be
   * exactly the nagging §29 forbids — the household has not failed to do
   * anything by not spending money they merely intended to.
   */
  it('never raises a signal for PLANNED outgoing money', () => {
    const items = derive({
      cashflowEvents: [
        event({ requirement: 'planned', expectedDate: '2026-08-15' }),
      ],
    });
    expect(codes(items)).not.toContain('cashflow_required_due_soon');
  });

  it('never raises a signal for incoming money', () => {
    const items = derive({
      cashflowEvents: [
        event({
          direction: 'incoming',
          requirement: null,
          expectedDate: '2026-08-15',
        }),
      ],
    });
    expect(items).toEqual([]);
  });

  /**
   * The forecast clamps an overdue occurrence onto today, so its `date` reads
   * as today. Only `wasClampedFromPast` still says it was late — if that check
   * came second, every overdue bill would report as "due in 0 days".
   */
  it('reports an overdue event as overdue, not as due today', () => {
    const items = derive({
      cashflowEvents: [event({ expectedDate: '2026-07-20' })],
    });

    expect(codes(items)).toContain('cashflow_overdue');
    expect(codes(items)).not.toContain('cashflow_required_due_soon');
  });

  /**
   * A monthly rent produces an occurrence every month inside the horizon.
   * Emitting one signal per occurrence would bury the household in copies of
   * the same fact.
   */
  it('collapses a recurring series to ONE signal', () => {
    const items = derive({
      horizonDays: 90,
      cashflowEvents: [
        event({ recurrence: 'monthly', expectedDate: '2026-08-15' }),
      ],
    });

    expect(
      items.filter((i) => i.ruleCode === 'cashflow_required_due_soon'),
    ).toHaveLength(1);
  });

  it('ignores synthetic what-if events', () => {
    const items = derive({
      cashflowEvents: [],
      options: {
        syntheticEvents: [
          event({ id: 'synthetic', isSynthetic: true, expectedDate: TODAY }),
        ],
      },
    });
    expect(codes(items)).not.toContain('cashflow_required_due_soon');
  });
});

describe('deriveAttentionItems — household-level signals', () => {
  it('raises low_projected_balance when the forecast dips below zero', () => {
    const items = derive({
      assets: [asset({ value: 5 * M })],
      cashflowEvents: [event({ amount: 20 * M, expectedDate: '2026-08-20' })],
    });

    const item = items.find((i) => i.ruleCode === 'low_projected_balance')!;
    expect(item).toBeDefined();
    expect(item.level).toBe('urgent');
    expect(item.params.lowestProjectedBalance).toBe(-15 * M);
    expect(item.relatedObjectId).toBeNull();
  });

  it('stays silent when the dip stays positive', () => {
    const items = derive({
      assets: [asset({ value: 30 * M })],
      cashflowEvents: [event({ amount: 15 * M, expectedDate: '2026-08-20' })],
    });

    expect(codes(items)).not.toContain('low_projected_balance');
  });

  it('is silent when nothing is wrong', () => {
    const items = derive({
      assets: [asset({ value: 100 * M })],
      cashflowEvents: [event({ amount: 1 * M, expectedDate: '2026-09-05' })],
    });
    expect(items).toEqual([]);
  });

  it('raises one stale_data signal per stale asset', () => {
    const items = derive({}, [
      { assetId: 'a1', name: 'VCB', daysSinceUpdate: 45 },
      { assetId: 'a2', name: 'Vi', daysSinceUpdate: 60 },
    ]);

    expect(items.filter((i) => i.ruleCode === 'stale_data')).toHaveLength(2);
    expect(items[0].params.daysSinceUpdate).toBe(45);
    // Data quality is never a judgement about the couple's money.
    expect(items[0].level).toBe('normal');
  });
});

describe('derived ids', () => {
  /**
   * Stability is the whole contract: a dismissal recorded against one read must
   * still match on the next. If these ids embedded a date or an index, every
   * dismissal would silently stop working.
   */
  it('is stable across recomputation', () => {
    const first = derive({
      cashflowEvents: [event({ expectedDate: '2026-08-15' })],
    });
    const second = derive({
      cashflowEvents: [event({ expectedDate: '2026-08-15' })],
    });

    expect(first[0].id).toBe(second[0].id);
    expect(first[0].id).toBe(
      derivedAttentionId('cashflow_required_due_soon', 'e1'),
    );
  });

  it('collapses household-level signals onto one scope', () => {
    expect(derivedAttentionId('low_projected_balance', null)).toBe(
      'derived:low_projected_balance:household',
    );
  });
});

describe('thresholds', () => {
  // Pinned so changing one is a deliberate edit against a failing test rather
  // than a number quietly drifting inside a conditional.
  it('are what the rules claim', () => {
    expect(ATTENTION_THRESHOLDS).toEqual({
      dueSoonDays: 7,
    });
  });
});

describe('purity', () => {
  /**
   * §29's core constraint as an executable assertion: a derived signal must
   * never be persisted. `attention_items` has no `deleted_at`, so a stale
   * persisted row would be indistinguishable from a user dismissal.
   */
  it('returns plain data and mutates no input', () => {
    const input: ForecastInput = {
      householdId: 'hh-1',
      asOfDate: TODAY,
      horizonDays: 30,
      assets: [asset()],
      cashflowEvents: [event()],
    };
    const before = JSON.stringify(input);
    const forecast = runForecast(input);

    deriveAttentionItems({
      asOfDate: TODAY,
      forecast,
      flexible: computeFlexibleMoney(forecast),
    });

    expect(JSON.stringify(input)).toBe(before);
  });
});

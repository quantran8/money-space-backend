import { BadRequestException } from '@nestjs/common';
import { todayInTimeZone } from '../../common/utils/clock';
import { ForecastService } from './forecast.service';
import { CacheService } from '../../common/cache/cache.service';
import type { ForecastBundle } from './repositories/forecast.repository.interface';

const M = 1_000_000;
// Must match the service's clock: it anchors to the household timezone
// (Asia/Ho_Chi_Minh), which is a day ahead of UTC for part of every day.
const TODAY = todayInTimeZone();

function bundle(over: Partial<ForecastBundle> = {}): ForecastBundle {
  return {
    assets: [
      {
        assetId: 'a1',
        name: 'VCB',
        value: 100 * M,
        liquidity: 'usable_now',
        financialNature: 'household',
        valueUpdatedAt: TODAY,
      },
    ],
    cashflowEvents: [],
    ...over,
  };
}

function setup(over: Partial<ForecastBundle> = {}, goal?: unknown) {
  const loadForecastBundle = jest.fn(async () => bundle(over));
  const forecastRepository = {
    assertHousehold: jest.fn(async () => ({}) as never),
    loadForecastBundle,
  } as never;
  const goalsRepository = {
    findFinancialGoalById: jest.fn(async () => goal),
  } as never;
  // A real CacheService with no Redis configured: `wrap` falls straight through
  // to the loader, so these tests exercise the actual cached code path rather
  // than a stub, while staying offline.
  const cache = new CacheService();
  const service = new ForecastService(
    forecastRepository,
    goalsRepository,
    cache,
  );
  return {
    service,
    loadForecastBundle,
    forecastRepository,
    goalsRepository,
    cache,
  };
}

describe('ForecastService.parseHorizon', () => {
  it('defaults to 30', () => {
    const { service } = setup();
    expect(service.parseHorizon(undefined)).toBe(30);
    expect(service.parseHorizon('')).toBe(30);
  });

  it.each([[7], [30], [60], [90]])('accepts %s', (days) => {
    const { service } = setup();
    expect(service.parseHorizon(String(days))).toBe(days);
  });

  it.each([['45'], ['0'], ['-1'], ['abc'], ['365']])('rejects %s', (value) => {
    const { service } = setup();
    expect(() => service.parseHorizon(value)).toThrow(BadRequestException);
  });
});

describe('ForecastService.whatIf', () => {
  const spend = { amount: 30 * M, plannedDate: TODAY };

  it('loads the forecast bundle exactly ONCE for before + after', async () => {
    const { service, loadForecastBundle } = setup();

    await service.whatIf('hh-1', spend);

    // Running the engine twice must not mean querying twice.
    expect(loadForecastBundle).toHaveBeenCalledTimes(1);
  });

  it('reduces flexible money by the spend', async () => {
    const { service } = setup();

    const result = await service.whatIf('hh-1', spend);

    expect(result.before.lowestProjectedBalance).toBe(100 * M);
    expect(result.after.lowestProjectedBalance).toBe(70 * M);
    expect(result.delta.lowestProjectedBalance).toBe(-30 * M);
  });

  it('classifies a comfortable spend', async () => {
    const { service } = setup();
    const result = await service.whatIf('hh-1', { ...spend, amount: 1 * M });
    expect(result.resultType).toBe('comfortable');
  });

  it('classifies a spend that goes negative as tight', async () => {
    const { service } = setup();
    const result = await service.whatIf('hh-1', { ...spend, amount: 150 * M });
    expect(result.resultType).toBe('tight');
  });

  /**
   * §26D: what-if persists NOTHING. There is no `what_if_scenarios` table and
   * there must not be one. This asserts the guarantee rather than trusting it —
   * the repositories expose only reads, and nothing else is touched.
   */
  it('never writes: only the read methods are ever called', async () => {
    const { service, forecastRepository, goalsRepository } = setup();

    await service.whatIf('hh-1', spend);

    const called = (repo: object) =>
      Object.entries(repo)
        .filter(([, value]) => jest.isMockFunction(value))
        .filter(([, value]) => (value as jest.Mock).mock.calls.length > 0)
        .map(([name]) => name);

    // `loadForecastBundle` alone: access is settled by `HouseholdAccessGuard`
    // before the handler runs, so the service no longer re-asserts the
    // household.
    expect(called(forecastRepository).sort()).toEqual(['loadForecastBundle']);
    expect(called(goalsRepository)).toEqual([]);
  });

  it.each([
    ['zero amount', { amount: 0 }],
    ['negative amount', { amount: -1 }],
  ])('rejects %s', async (_label, patch) => {
    const { service } = setup();
    await expect(
      service.whatIf('hh-1', { ...spend, ...patch }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a planned date outside the horizon', async () => {
    const { service } = setup();
    await expect(
      service.whatIf('hh-1', { ...spend, plannedDate: '2099-01-01' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a goal that does not belong to the household', async () => {
    const { service } = setup({}, undefined);
    await expect(
      service.whatIf('hh-1', { ...spend, goalId: 'nope' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('reports the time cost against a goal', async () => {
    const { service } = setup(
      {},
      {
        id: 'g1',
        targetAmount: 1000 * M,
        currentAmount: 600 * M,
        plannedMonthlyContribution: 10 * M,
        targetDate: 'No deadline',
      },
    );

    const result = await service.whatIf('hh-1', { ...spend, goalId: 'g1' });

    // 30M spend against a 10M/month pace ≈ 3 months later.
    expect(result.delta.goalDelayMonths).toBe(3);
    expect(result.delta.goalDelayDays).toBe(90);
    expect(result.before.goal?.estimatedMonthsToGoal).toBe(40);
    expect(result.after.goal?.estimatedMonthsToGoal).toBe(43);
  });

  it('cannot express a time cost when the goal has no declared pace', async () => {
    const { service } = setup(
      {},
      {
        id: 'g1',
        targetAmount: 1000 * M,
        currentAmount: 600 * M,
        plannedMonthlyContribution: null,
        targetDate: 'No deadline',
      },
    );

    const result = await service.whatIf('hh-1', { ...spend, goalId: 'g1' });

    expect(result.delta.goalDelayMonths).toBeNull();
    expect(result.after.goal?.reason).toBe('no_contribution');
  });

  it('carries the assumptions through so the client can explain the number', async () => {
    const { service } = setup();
    const result = await service.whatIf('hh-1', spend);
    expect(result.assumptions.map((a) => a.code)).toContain('horizon_days');
  });
});

describe('ForecastService caching', () => {
  /**
   * Injects a working in-memory cache into the service built by `setup()`.
   * `CacheService` refuses to build a client under NODE_ENV=test by design, so
   * the fake stands in for Redis while the real `wrap`/`get`/`set` logic runs.
   */
  function withCache(over: Partial<ForecastBundle> = {}) {
    const store = new Map<string, string>();
    const fakeRedis = {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK');
      },
      on: () => undefined,
    };
    const ctx = setup(over);
    (ctx.cache as unknown as { client: unknown }).client = fakeRedis;
    return { ...ctx, store };
  }

  it('loads the bundle once across repeated forecast reads', async () => {
    const { service, loadForecastBundle } = withCache();

    await service.forecast('hh-1', 30);
    await service.forecast('hh-1', 30);

    expect(loadForecastBundle).toHaveBeenCalledTimes(1);
  });

  it('serves flexibleMoney, financialState and the bundle from one load', async () => {
    // All three are pure functions of the forecast, so caching `forecast()`
    // must cover every endpoint that derives from it.
    const { service, loadForecastBundle } = withCache();

    await service.forecast('hh-1', 30);
    await service.flexibleMoney('hh-1', 30);
    await service.financialState('hh-1', 30);
    await service.forecastBundle('hh-1', 30);

    expect(loadForecastBundle).toHaveBeenCalledTimes(1);
  });

  it('keys by horizon, so a different horizon is not served stale', async () => {
    const { service, loadForecastBundle } = withCache();

    await service.forecast('hh-1', 30);
    await service.forecast('hh-1', 90);

    expect(loadForecastBundle).toHaveBeenCalledTimes(2);
  });

  it('keys by household, so one household never sees another figures', async () => {
    const { service, loadForecastBundle } = withCache();

    await service.forecast('hh-1', 30);
    await service.forecast('hh-2', 30);

    expect(loadForecastBundle).toHaveBeenCalledTimes(2);
  });

  it('never caches an explicit asOfDate', async () => {
    // Only the snapshot backfill passes a date; caching those would grow the
    // key space with entries nothing reads twice.
    const { service, loadForecastBundle, store } = withCache();

    await service.forecast('hh-1', 30, TODAY);
    await service.forecast('hh-1', 30, TODAY);

    expect(loadForecastBundle).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });

  it('does not let a what-if read poison the cached forecast', async () => {
    // what-if runs the engine over a hypothetical event; that result must never
    // become the household's real cached forecast.
    const { service, store } = withCache();

    await service.forecast('hh-1', 30);
    const cachedBefore = store.get('money-space:hh:hh-1:forecast:30');

    await service.whatIf('hh-1', {
      amount: 5 * M,
      plannedDate: TODAY,
      horizonDays: 30,
    });

    expect(store.get('money-space:hh:hh-1:forecast:30')).toBe(cachedBefore);
  });
});

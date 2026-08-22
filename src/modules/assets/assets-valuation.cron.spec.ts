import { AssetsValuationCron } from './assets-valuation.cron';
import type { AssetsService } from './assets.service';
import type { AssetsRepository } from './repositories/assets.repository.interface';
import type { PrismaService } from '../../database/prisma/prisma.service';

function build(
  householdIds: string[],
  refresh?: jest.Mock<Promise<{ refreshed: number }>, [string]>,
) {
  const findHouseholds = jest
    .fn<Promise<string[]>, [string, number]>()
    .mockResolvedValue(householdIds);
  const refreshMarketValuations =
    refresh ??
    jest
      .fn<Promise<{ refreshed: number }>, [string]>()
      .mockResolvedValue({ refreshed: 2 });

  // The advisory lock is exercised for real in `advisory-lock.spec.ts`; here it
  // always grants, so these cases test the batch logic itself.
  const prisma = {
    client: () => ({
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ ok: true }]),
    }),
  } as unknown as PrismaService;

  const cron = new AssetsValuationCron(
    { refreshMarketValuations } as unknown as AssetsService,
    {
      findHouseholdsNeedingMarketValuation: findHouseholds,
    } as unknown as AssetsRepository,
    prisma,
  );
  return { cron, findHouseholds, refreshMarketValuations };
}

describe('AssetsValuationCron', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('prices every household the work list returns', async () => {
    const { cron, refreshMarketValuations } = build(['h1', 'h2', 'h3']);

    const result = await cron.run();

    expect(refreshMarketValuations).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ households: 3, assets: 6 });
  });

  it('does nothing when every household is already priced today', async () => {
    const { cron, refreshMarketValuations } = build([]);

    const result = await cron.run();

    expect(refreshMarketValuations).not.toHaveBeenCalled();
    expect(result).toEqual({ households: 0, assets: 0 });
  });

  it('caps in-flight refreshes to protect the connection pool', async () => {
    process.env.MARKET_VALUATION_CONCURRENCY = '2';
    let inFlight = 0;
    let peak = 0;
    const refresh = jest.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { refreshed: 1 };
    });
    const { cron } = build(['a', 'b', 'c', 'd', 'e'], refresh as never);

    await cron.run();

    // The pool is small; the job must never open more than its budget at once.
    expect(peak).toBeLessThanOrEqual(2);
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  it('keeps going when one household fails', async () => {
    const refresh = jest.fn((householdId: string) => {
      if (householdId === 'bad') {
        return Promise.reject(new Error('upstream down'));
      }
      return Promise.resolve({ refreshed: 1 });
    });
    const { cron } = build(['good1', 'bad', 'good2'], refresh as never);

    const result = await cron.run();

    // The two healthy households still get their data point for the day.
    expect(result).toEqual({ households: 3, assets: 2 });
  });

  it('skips a tick that overlaps a still-running one', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = jest.fn(async () => {
      await gate;
      return { refreshed: 1 };
    });
    const { cron, findHouseholds } = build(['h1'], refresh as never);

    const first = cron.run();
    // A second tick while the first is mid-flight must not double the load.
    const second = await cron.run();
    expect(second).toEqual({ households: 0, assets: 0 });

    release();
    await first;
    expect(findHouseholds).toHaveBeenCalledTimes(1);
  });

  it('runs again after a previous run finishes', async () => {
    const { cron, findHouseholds } = build(['h1']);

    await cron.run();
    await cron.run();

    expect(findHouseholds).toHaveBeenCalledTimes(2);
  });

  it('honours the env switch that disables it on an instance', async () => {
    process.env.MARKET_VALUATION_CRON_ENABLED = 'false';
    const { cron, findHouseholds } = build(['h1']);

    await cron.captureDailyValuations();

    expect(findHouseholds).not.toHaveBeenCalled();
  });

  it('asks for the work list with today and the batch limit', async () => {
    process.env.MARKET_VALUATION_BATCH_LIMIT = '25';
    const { cron, findHouseholds } = build([]);

    await cron.run();

    expect(findHouseholds).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      25,
    );
  });

  it('stamps every household with one date, even if the run crosses midnight', async () => {
    // The job fires at 23:45, so a slow batch can roll over into the next day.
    // Re-reading "today" per household would split one run across two dates.
    const seen: Array<string | undefined> = [];
    const refresh = jest.fn((_id: string, valuationDate?: string) => {
      seen.push(valuationDate);
      return Promise.resolve({ refreshed: 1 });
    });
    const { cron } = build(['h1', 'h2', 'h3'], refresh as never);

    await cron.run();

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('skips the whole run when another instance holds the lock', async () => {
    // Every instance fires the schedule; only one should do the work.
    const findHouseholds = jest.fn();
    const refreshMarketValuations = jest.fn();
    const prisma = {
      client: () => ({
        // pg_try_advisory_lock returns false when someone else holds it.
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ ok: false }]),
      }),
    } as unknown as PrismaService;
    const cron = new AssetsValuationCron(
      { refreshMarketValuations } as unknown as AssetsService,
      {
        findHouseholdsNeedingMarketValuation: findHouseholds,
      } as unknown as AssetsRepository,
      prisma,
    );

    const result = await cron.run();

    expect(result).toEqual({ households: 0, assets: 0 });
    // It must not even build a work list, let alone price anything.
    expect(findHouseholds).not.toHaveBeenCalled();
    expect(refreshMarketValuations).not.toHaveBeenCalled();
  });
});

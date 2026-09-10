import { MonthEndCron } from './month-end.cron';
import type { SettlementShareRow } from '../goals/repositories/goals.repository.interface';

const M = 1_000_000;

function share(over: Partial<SettlementShareRow> = {}): SettlementShareRow {
  return {
    allocationId: 'alloc-tcb',
    goalId: 'goal-car',
    assetId: 'tcb',
    allocatedAmount: 20 * M,
    monthlyContribution: 10 * M,
    sharePercent: null,
    priority: 'high',
    ...over,
  };
}

function setup(
  options: {
    shares?: SettlementShareRow[];
    lastSettledMonth?: string;
    walletValue?: number;
    /** Written rows, so a re-run can report "already settled". */
    inserted?: number;
    /** Make the snapshot half fail, to prove it does not block settling. */
    snapshotFails?: boolean;
  } = {},
) {
  const shares = options.shares ?? [share()];
  const insertSettlementsAndAdvanceLedgers = jest.fn(() =>
    Promise.resolve(options.inserted ?? shares.length),
  );
  const goalsRepository = {
    findHouseholdIdsWithContributionShares: jest.fn(() =>
      Promise.resolve(['hh-1']),
    ),
    findContributionSharesForSettlement: jest.fn(() => Promise.resolve(shares)),
    findLastSettledMonth: jest.fn(() =>
      Promise.resolve(options.lastSettledMonth),
    ),
    insertSettlementsAndAdvanceLedgers,
  };
  const assetsService = {
    getActiveAssetRecords: jest.fn(() =>
      Promise.resolve([
        {
          id: 'tcb',
          type: 'bank_account',
          currentValue: options.walletValue ?? 40 * M,
        },
      ]),
    ),
  };
  const createSnapshot = jest.fn(() =>
    options.snapshotFails
      ? Promise.reject(new Error('forecast unavailable'))
      : Promise.resolve(undefined),
  );
  const snapshotsService = { createSnapshot };
  const snapshotsRepository = {
    findAllHouseholdIds: jest.fn(() => Promise.resolve(['hh-1'])),
  };
  const prisma = {
    runInTransaction: jest.fn((work: () => Promise<unknown>) => work()),
    // `withAdvisoryLock` takes a cluster-wide lock before any work happens.
    client: () => ({
      $queryRawUnsafe: jest.fn(() => Promise.resolve([{ ok: true }])),
    }),
  };
  const cron = new MonthEndCron(
    goalsRepository as never,
    assetsService as never,
    snapshotsService as never,
    snapshotsRepository as never,
    prisma as never,
  );
  return {
    cron,
    insertSettlementsAndAdvanceLedgers,
    goalsRepository,
    createSnapshot,
  };
}

describe('MonthEndCron', () => {
  const realDate = Date;

  function freezeAt(iso: string) {
    // The job reads the calendar through `todayInTimeZone`, so the clock is the
    // only input that decides which months are closed.
    global.Date = class extends realDate {
      constructor(...args: unknown[]) {
        // @ts-expect-error - passthrough
        super(...(args.length ? args : [iso]));
      }
      static now() {
        return new realDate(iso).getTime();
      }
    } as DateConstructor;
  }

  afterEach(() => {
    global.Date = realDate;
  });

  it('closes the month that has just ended', async () => {
    freezeAt('2026-09-01T00:20:00+07:00');
    const { cron, insertSettlementsAndAdvanceLedgers } = setup();
    await cron.run();
    expect(insertSettlementsAndAdvanceLedgers).toHaveBeenCalledWith(
      'hh-1',
      '2026-08',
      expect.arrayContaining([
        expect.objectContaining({
          opening: 20 * M,
          closing: 30 * M,
          actual: 10 * M,
        }),
      ]),
    );
  });

  // A household never settled has no earlier balance to close older months
  // against; back-dating them to today's figure would invent a history.
  it('only closes the most recent ended month for a new household', async () => {
    freezeAt('2026-09-01T00:20:00+07:00');
    const { cron, insertSettlementsAndAdvanceLedgers } = setup();
    await cron.run();
    expect(insertSettlementsAndAdvanceLedgers).toHaveBeenCalledTimes(1);
  });

  it('catches up every month missed since the last close', async () => {
    freezeAt('2026-09-01T00:20:00+07:00');
    const { cron, insertSettlementsAndAdvanceLedgers } = setup({
      lastSettledMonth: '2026-05',
    });
    await cron.run();
    const months = insertSettlementsAndAdvanceLedgers.mock.calls as unknown as [
      string,
      string,
      unknown,
    ][];
    expect(months.map((call) => call[1])).toEqual([
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
  });

  // The current month is still running: it has no closing balance yet.
  it('never closes the month still running', async () => {
    freezeAt('2026-09-15T00:20:00+07:00');
    const { cron, insertSettlementsAndAdvanceLedgers } = setup({
      lastSettledMonth: '2026-08',
    });
    await cron.run();
    expect(insertSettlementsAndAdvanceLedgers).not.toHaveBeenCalled();
  });

  it('crosses the year boundary', async () => {
    freezeAt('2027-01-01T00:20:00+07:00');
    const { cron, insertSettlementsAndAdvanceLedgers } = setup({
      lastSettledMonth: '2026-11',
    });
    await cron.run();
    expect(insertSettlementsAndAdvanceLedgers).toHaveBeenCalledWith(
      'hh-1',
      '2026-12',
      expect.anything(),
    );
  });

  it('does nothing when the month is already settled', async () => {
    freezeAt('2026-09-01T00:20:00+07:00');
    const { cron, insertSettlementsAndAdvanceLedgers } = setup({
      lastSettledMonth: '2026-08',
    });
    await cron.run();
    expect(insertSettlementsAndAdvanceLedgers).not.toHaveBeenCalled();
  });

  // The wallet fell short: the ledger settles at what is really there, and the
  // shortfall is reported rather than clamped away.
  it('records a shortfall against the wallet balance', async () => {
    freezeAt('2026-09-01T00:20:00+07:00');
    const { cron, insertSettlementsAndAdvanceLedgers } = setup({
      walletValue: 26 * M,
    });
    await cron.run();
    expect(insertSettlementsAndAdvanceLedgers).toHaveBeenCalledWith(
      'hh-1',
      '2026-08',
      [
        expect.objectContaining({
          closing: 26 * M,
          actual: 6 * M,
          walletBalance: 26 * M,
          shortOnWallet: true,
        }),
      ],
    );
  });

  // The whole reason the two phases share a job: the snapshot has to freeze the
  // ledgers BEFORE the settlement rewrites them, or every frozen goal figure is
  // a month ahead of the picture it claims to be.
  it('snapshots before it settles', async () => {
    freezeAt('2026-09-01T00:20:00+07:00');
    const { cron, createSnapshot, insertSettlementsAndAdvanceLedgers } =
      setup();
    await cron.run();
    const snapshotAt = createSnapshot.mock.invocationCallOrder[0];
    const settleAt =
      insertSettlementsAndAdvanceLedgers.mock.invocationCallOrder[0];
    expect(snapshotAt).toBeLessThan(settleAt);
  });

  // A snapshot is a record, not a precondition. A household whose forecast will
  // not build still deserves its ledgers closed.
  it('still settles when the snapshot fails', async () => {
    freezeAt('2026-09-01T00:20:00+07:00');
    const { cron, insertSettlementsAndAdvanceLedgers } = setup({
      snapshotFails: true,
    });
    await cron.run();
    expect(insertSettlementsAndAdvanceLedgers).toHaveBeenCalled();
  });

  it('skips a household with no contribution shares', async () => {
    freezeAt('2026-09-01T00:20:00+07:00');
    const { cron, insertSettlementsAndAdvanceLedgers } = setup({ shares: [] });
    await cron.run();
    expect(insertSettlementsAndAdvanceLedgers).not.toHaveBeenCalled();
  });
});

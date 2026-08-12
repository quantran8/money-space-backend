import { ConflictException } from '@nestjs/common';
import { SnapshotsService } from './snapshots.service';
import type { ForecastInput } from '../forecast/domain/forecast.types';
import type {
  CreateSnapshotInput,
  SnapshotAssetLine,
} from './repositories/snapshots.repository.interface';

const M = 1_000_000;
const TODAY_LINES: SnapshotAssetLine[] = [
  {
    assetId: 'a1',
    assetName: 'VCB',
    assetType: 'bank_account',
    liquidity: 'usable_now',
    value: 20 * M,
    currency: 'VND',
    visibilityLevel: 'detail',
    financialNature: 'household',
    holderMemberId: 'm1',
    privacyOwnerMemberId: null,
  },
  {
    assetId: 'a2',
    assetName: 'Vàng',
    assetType: 'gold',
    liquidity: 'long_term',
    value: 50 * M,
    currency: 'VND',
    visibilityLevel: 'detail',
    financialNature: 'personal_included',
    holderMemberId: 'm2',
    privacyOwnerMemberId: 'm2',
  },
];

function setup(
  options: { lastCreatedAt?: Date | null; input?: Partial<ForecastInput> } = {},
) {
  const created: CreateSnapshotInput[] = [];

  const snapshotsRepository = {
    assertHousehold: jest.fn(async () => ({ id: 'hh-1' })),
    createId: jest.fn(() => 'snap-1'),
    getClassifiedAssetLines: jest.fn(async () => TODAY_LINES),
    getOutstandingDebtTotal: jest.fn(async () => 10 * M),
    getLastSnapshotCreatedAt: jest.fn(
      async () => options.lastCreatedAt ?? null,
    ),
    createSnapshot: jest.fn(async (input: CreateSnapshotInput) => {
      created.push(input);
    }),
    listSnapshots: jest.fn(async () => []),
    getSnapshotById: jest.fn(async () => ({ id: 'snap-1' })),
  } as never;

  const forecast = {
    parseHorizon: jest.fn((raw?: number) => raw ?? 30),
    loadInput: jest.fn(
      async (householdId: string, horizonDays: number, asOfDate?: string) =>
        ({
          householdId,
          asOfDate: asOfDate ?? '2026-08-13',
          horizonDays,
          assets: [
            {
              assetId: 'a1',
              name: 'VCB',
              value: 20 * M,
              liquidity: 'usable_now',
              financialNature: 'household',
              visibilityLevel: 'detail',
              valueUpdatedAt: asOfDate ?? '2026-08-13',
            },
          ],
          cashflowEvents: [
            {
              id: 'e1',
              name: 'Rent',
              direction: 'outgoing',
              amount: 25 * M,
              expectedDate: '2026-08-15',
              recurrence: 'once',
              recurrenceEndDate: null,
              requirement: 'required',
              certainty: 'confirmed',
              status: 'expected',
              visibilityLevel: 'detail',
            },
          ],
          protectedReserves: [],
          ...options.input,
        }) as ForecastInput,
    ),
  } as never;

  const attention = {
    countOpenStoredItems: jest.fn(async () => 3),
  } as never;

  return {
    service: new SnapshotsService(snapshotsRepository, forecast, attention),
    snapshotsRepository: snapshotsRepository as never as Record<string, jest.Mock>,
    attention: attention as never as Record<string, jest.Mock>,
    created,
  };
}

describe('SnapshotsService.createSnapshot', () => {
  it('freezes the six foresight columns', async () => {
    const { service, created } = setup();

    await service.createSnapshot('hh-1');

    const [snapshot] = created;
    expect(snapshot.forecastHorizonDays).toBe(30);
    expect(snapshot.protectedReserveAmount).toBe(0);
    expect(snapshot.upcomingOutgoingAmount).toBe(25 * M);
    expect(snapshot.lowestProjectedBalance).toBe(-5 * M);
    expect(snapshot.flexibleMoney).toBe(-5 * M);
  });

  /**
   * §10 explicitly forbids a `>= 0` CHECK on these two columns. A projected
   * shortfall is the single most important thing a snapshot can record — a
   * clamp here would erase exactly the fact the product exists to surface.
   */
  it('stores a NEGATIVE projected balance unchanged', async () => {
    const { service, created } = setup();

    await service.createSnapshot('hh-1');

    expect(created[0].lowestProjectedBalance).toBeLessThan(0);
  });

  it('freezes each asset line with its classification', async () => {
    const { service, created } = setup();

    await service.createSnapshot('hh-1');

    const gold = created[0].lines.find((line) => line.assetId === 'a2');
    expect(gold).toMatchObject({
      financialNature: 'personal_included',
      holderMemberId: 'm2',
      privacyOwnerMemberId: 'm2',
    });
  });

  /**
   * The header figure and the per-asset breakdown come from the SAME lines, so
   * they cannot disagree — the failure mode of the retired auto-hooks, which
   * recomputed totals from a separate live query.
   */
  it('derives the totals from the lines it freezes', async () => {
    const { service, created } = setup();

    await service.createSnapshot('hh-1');

    expect(created[0].totalLiquid).toBe(20 * M);
    expect(created[0].totalLongTermAssets).toBe(50 * M);
    expect(created[0].totalSavings).toBe(0);
  });

  /** §29: a derived count isn't reproducible, so only stored items are frozen. */
  it('freezes the STORED attention count only', async () => {
    const { service, created, attention } = setup();

    await service.createSnapshot('hh-1');

    expect(attention.countOpenStoredItems).toHaveBeenCalledWith('hh-1');
    expect(created[0].attentionCount).toBe(3);
  });

  it('rejects a second snapshot within the rate-limit window', async () => {
    const { service } = setup({ lastCreatedAt: new Date(Date.now() - 5_000) });

    await expect(service.createSnapshot('hh-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('allows one once the window has passed', async () => {
    const { service, created } = setup({
      lastCreatedAt: new Date(Date.now() - 120_000),
    });

    await service.createSnapshot('hh-1');

    expect(created).toHaveLength(1);
  });

  /**
   * Snapshots are APPEND-ONLY. The repository exposes no update or delete for
   * them, and this asserts the service never reaches for one — the exact
   * regression that made the auto-hooks rewrite snapshots after the fact.
   */
  it('never updates or deletes an existing snapshot', async () => {
    const { service, snapshotsRepository } = setup();

    await service.createSnapshot('hh-1');

    const writeMethods = Object.keys(snapshotsRepository).filter(
      (name) => /update|delete|upsert|recompute/i.test(name),
    );
    expect(writeMethods).toEqual([]);
    expect(snapshotsRepository.createSnapshot).toHaveBeenCalledTimes(1);
  });

  /**
   * An interactive transaction is one connection held open. Valuing assets and
   * running a forecast inside it is how the old path died with "Transaction not
   * found" — so the reads must all complete before the write begins.
   */
  it('completes every read before the transactional write', async () => {
    const { service, snapshotsRepository } = setup();

    await service.createSnapshot('hh-1');

    const writeOrder =
      snapshotsRepository.createSnapshot.mock.invocationCallOrder[0];
    for (const read of [
      snapshotsRepository.getClassifiedAssetLines,
      snapshotsRepository.getOutstandingDebtTotal,
    ]) {
      expect(read.mock.invocationCallOrder[0]).toBeLessThan(writeOrder);
    }
  });

  it('reads the stored row back rather than echoing a hand-built object', async () => {
    const { service, snapshotsRepository } = setup();

    await service.createSnapshot('hh-1');

    expect(snapshotsRepository.getSnapshotById).toHaveBeenCalledWith(
      'hh-1',
      'snap-1',
    );
  });
});

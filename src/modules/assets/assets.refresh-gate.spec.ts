import { AssetsService } from './assets.service';
import type { AssetsRepository } from './repositories/assets.repository.interface';
import type { PrismaService } from '../../database/prisma/prisma.service';
import type { SnapshotsService } from '../snapshots/snapshots.service';
import type { MarketDataService } from '../market-data/market-data.service';

describe('AssetsService.refreshMarketValuationsIfStale', () => {
  function build(overrides: Partial<AssetsRepository> = {}) {
    const repository = {
      assertHousehold: jest.fn().mockResolvedValue({ id: 'household-1' }),
      hasMarketValuationOnDate: jest.fn().mockResolvedValue(false),
      findAssetsByHousehold: jest.fn().mockResolvedValue([]),
      getFxRates: jest.fn().mockResolvedValue([]),
      ...overrides,
    } as unknown as AssetsRepository;
    const prisma = {
      runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
    } as unknown as PrismaService;
    const snapshots = {
      onAssetChanged: jest.fn().mockResolvedValue(undefined),
    } as unknown as SnapshotsService;
    const marketData = {
      getMarketPrices: jest.fn().mockResolvedValue([]),
    } as unknown as MarketDataService;
    const service = new AssetsService(
      repository,
      prisma,
      snapshots,
      marketData,
    );
    return { service, repository, marketData };
  }

  it('skips the refresh when the household was already priced today', async () => {
    const { service, marketData, repository } = build({
      hasMarketValuationOnDate: jest.fn().mockResolvedValue(true),
    });

    const result = await service.refreshMarketValuationsIfStale('household-1');

    expect(result).toEqual({ refreshed: 0, skipped: true });
    expect(repository.assertHousehold).not.toHaveBeenCalled();
    expect(marketData.getMarketPrices).not.toHaveBeenCalled();
  });

  it('runs the refresh when the household has not been priced today', async () => {
    const { service, marketData } = build();

    const result = await service.refreshMarketValuationsIfStale('household-1');

    expect(result).toEqual({ refreshed: 0, skipped: false });
    // The refresh force-refreshes the provider cache.
    expect(marketData.getMarketPrices).toHaveBeenCalledWith(true);
  });

  it('swallows errors and returns undefined (never throws to the caller)', async () => {
    const { service } = build({
      hasMarketValuationOnDate: jest
        .fn()
        .mockRejectedValue(new Error('db down')),
    });

    await expect(
      service.refreshMarketValuationsIfStale('household-1'),
    ).resolves.toBeUndefined();
  });

  it('de-duplicates a concurrent in-flight refresh for the same household', async () => {
    let resolveGate: (v: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((resolve) => {
      resolveGate = resolve;
    });
    const hasMarketValuationOnDate = jest.fn().mockReturnValue(gate);
    const { service } = build({ hasMarketValuationOnDate });

    const first = service.refreshMarketValuationsIfStale('household-1');
    const second = service.refreshMarketValuationsIfStale('household-1');

    // The second call short-circuits before touching the DB gate.
    expect(await second).toEqual({ refreshed: 0, skipped: true });

    resolveGate(true);
    await first;
    expect(hasMarketValuationOnDate).toHaveBeenCalledTimes(1);
  });
});

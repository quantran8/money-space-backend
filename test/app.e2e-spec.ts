import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { AppService } from './../src/app.service';
import { Asset } from '../src/modules/assets/entities/asset.entity';
import { AssetsService } from '../src/modules/assets/assets.service';
import { ASSETS_REPOSITORY } from '../src/modules/assets/repositories/assets.repository.interface';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import { DASHBOARD_REPOSITORY } from '../src/modules/dashboard/repositories/dashboard.repository.interface';
import { HouseholdsService } from '../src/modules/households/households.service';
import { HOUSEHOLDS_REPOSITORY } from '../src/modules/households/repositories/households.repository.interface';

describe('AppModule integration', () => {
  let app: INestApplication;
  let appService: AppService;
  let householdsService: HouseholdsService;
  let dashboardService: DashboardService;
  let assetsService: AssetsService;

  beforeEach(async () => {
    const household = {
      id: 'household-minh',
      name: 'Minh family',
      currency: 'VND',
      updateFrequency: 'weekly',
      createdBy: 'profile-minh',
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    const assets: Asset[] = [
      {
        id: 'asset-cash',
        householdId: household.id,
        name: 'Tien mat',
        type: 'cash',
        valuationMode: 'manual',
        liquidity: 'usable_now',
        currency: 'VND',
        note: '',
        manualValue: 1_000_000,
      },
    ];
    const repositoryMock = {
      assertHousehold: jest.fn(async () => household),
      createId: jest.fn(() => crypto.randomUUID()),
      getHouseholds: jest.fn(async () => [household]),
      countMembers: jest.fn(async () => 1),
      findAssetsByHousehold: jest.fn(async () => assets),
      findAssetById: jest.fn(async (_householdId: string, assetId: string) =>
        assets.find((asset) => asset.id === assetId),
      ),
      insertAsset: jest.fn(async (asset: Asset) => {
        assets.unshift(asset);
      }),
      updateAsset: jest.fn(async (assetId: string, asset: Asset) => {
        const index = assets.findIndex((item) => item.id === assetId);
        assets[index] = asset;
      }),
      deleteAsset: jest.fn(async (assetId: string) => {
        const index = assets.findIndex((asset) => asset.id === assetId);
        assets.splice(index, 1);
      }),
      findAssetValuations: jest.fn(async () => []),
      findAssetValuation: jest.fn(async () => undefined),
      insertAssetValuation: jest.fn(async () => undefined),
      deleteAssetValuations: jest.fn(async () => undefined),
      unlinkAssetFromMoneyEvents: jest.fn(async () => undefined),
      getSnapshotsByHousehold: jest.fn(async () => []),
      getMarketPrices: jest.fn(async () => []),
      getFxRates: jest.fn(async () => []),
      getAttentionItems: jest.fn(async () => []),
      findUpcomingPaymentsByHousehold: jest.fn(async () => [
        {
          id: 'payment-1',
          householdId: household.id,
          name: 'Hoc phi',
          amount: 1_000_000,
          dueDate: '2026-07-10',
          owner: 'Minh',
          status: 'important',
        },
      ]),
      findFinancialGoalsByHousehold: jest.fn(async () => []),
      findMoneyEventsByHousehold: jest.fn(async () => [
        {
          id: 'event-1',
          householdId: household.id,
          amount: 10_000_000,
          note: 'Luong',
          isoDate: '2026-07-01',
          type: 'income',
          category: 'income',
          direction: 'inflow',
        },
      ]),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HOUSEHOLDS_REPOSITORY)
      .useValue(repositoryMock)
      .overrideProvider(DASHBOARD_REPOSITORY)
      .useValue(repositoryMock)
      .overrideProvider(ASSETS_REPOSITORY)
      .useValue(repositoryMock)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    appService = app.get(AppService);
    householdsService = app.get(HouseholdsService);
    dashboardService = app.get(DashboardService);
    assetsService = app.get(AssetsService);
  });

  it('exposes health metadata', () => {
    expect(appService.getHealth()).toMatchObject({
      status: 'ok',
      service: 'money-space-backend',
    });
  });

  it('returns households from the repository', async () => {
    const result = await householdsService.listHouseholds();

    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe('household-minh');
  });

  it('returns dashboard aggregate from repository data', async () => {
    const result = await dashboardService.getDashboard('household-minh');

    expect(result.snapshot.netWorthDisplay).toBeDefined();
    expect(result.payments).toHaveLength(1);
    expect(result.recentEvents).toHaveLength(1);
  });

  it('supports asset CRUD through the split domain service', async () => {
    const created = await assetsService.createAsset('household-minh', {
      name: 'Quy tien mat moi',
      type: 'cash',
      liquidity: 'usable_now',
      manualValue: 3_000_000,
      note: 'Repository test',
    });

    expect(created.name).toBe('Quy tien mat moi');

    const updated = await assetsService.updateAsset(
      'household-minh',
      created.id,
      {
        manualValue: 4_500_000,
      },
    );

    expect(updated.currentValue).toBe(4_500_000);

    const deleted = await assetsService.deleteAsset(
      'household-minh',
      created.id,
    );
    expect(deleted).toEqual({ deleted: true, assetId: created.id });
  });

  afterEach(async () => {
    await app.close();
  });
});

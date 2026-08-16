import { AssetsService } from './assets.service';
import type { Asset } from './entities/asset.entity';
import type { AssetValueHistory } from './entities/asset-value-history.entity';
import type { AssetsRepository } from './repositories/assets.repository.interface';
import type { PrismaService } from '../../database/prisma/prisma.service';
import type { MarketDataService } from '../market-data/market-data.service';

describe('AssetsService', () => {
  it('records an asset_purchase when a same-symbol position is increased', async () => {
    const existing: Asset = {
      id: 'asset-btc',
      householdId: 'household-1',
      name: 'Bitcoin',
      type: 'crypto',
      valuationMode: 'market_priced',
      liquidity: 'long_term',
      currency: 'VND',
      note: '',
      status: 'active',
      marketPosition: {
        assetClass: 'crypto',
        symbol: 'BTC',
        quantity: 1,
        unit: 'BTC',
        quoteCurrency: 'VND',
        purchasePrice: 100_000_000,
      },
    };
    const createId = jest
      .fn()
      .mockReturnValueOnce('asset-new')
      .mockReturnValueOnce('event-purchase')
      .mockReturnValueOnce('valuation-purchase');
    let updatedAssetId: string | undefined;
    let updatedAsset: Asset | undefined;
    const updateAsset = jest.fn(
      (assetId: string, asset: Asset): Promise<void> => {
        updatedAssetId = assetId;
        updatedAsset = asset;
        return Promise.resolve();
      },
    );
    type PurchaseEvent = {
      id: string;
      householdId: string;
      assetId: string;
      amount: number;
      isoDate: string;
      note: string;
    };
    let recordedPurchase: PurchaseEvent | undefined;
    const insertAssetPurchaseEvent = jest.fn(
      (event: PurchaseEvent): Promise<void> => {
        recordedPurchase = event;
        return Promise.resolve();
      },
    );
    let recordedValuation: AssetValueHistory | undefined;
    const insertAssetValueHistory = jest.fn(
      (valuation: AssetValueHistory): Promise<void> => {
        recordedValuation = valuation;
        return Promise.resolve();
      },
    );
    const repository = {
      createId,
      findActiveMarketAssetBySymbol: jest.fn().mockResolvedValue(existing),
      updateAsset,
      insertAssetPurchaseEvent,
      insertAssetValueHistory,
      updateAssetCurrentValue: jest.fn().mockResolvedValue(undefined),
      getFxRates: jest.fn().mockResolvedValue([]),
    } as unknown as AssetsRepository;
    const prisma = {
      runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
    } as unknown as PrismaService;
    const marketData = {
      getMarketPrices: jest.fn().mockResolvedValue([]),
    } as unknown as MarketDataService;
    const audit = { record: jest.fn() } as never;
    const service = new AssetsService(repository, prisma, marketData, audit);

    await service.createAsset('household-1', {
      name: 'BTC mua thêm',
      type: 'crypto',
      valuationMode: 'market_priced',
      marketPosition: {
        assetClass: 'crypto',
        symbol: 'btc',
        quantity: 0.5,
        unit: 'BTC',
        quoteCurrency: 'VND',
        purchasePrice: 200_000_000,
      },
    });

    expect(updatedAssetId).toBe(existing.id);
    expect(updatedAsset?.marketPosition?.quantity).toBe(1.5);
    expect(updatedAsset?.marketPosition?.purchasePrice).toBeCloseTo(
      133_333_333.33333333,
    );
    expect(recordedPurchase).toMatchObject({
      id: 'event-purchase',
      householdId: 'household-1',
      assetId: existing.id,
      amount: 100_000_000,
      note: 'Mua thêm 0,5 BTC BTC',
    });
    expect(recordedPurchase?.isoDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(recordedValuation?.id).toBe('valuation-purchase');
    expect(recordedValuation?.assetId).toBe(existing.id);
    expect(recordedValuation?.moneyEventId).toBe('event-purchase');
  });

  it('records a negative signed delta when an asset is revalued downward', async () => {
    const current: Asset = {
      id: 'asset-tcb',
      householdId: 'household-1',
      name: 'TCB',
      type: 'bank_account',
      valuationMode: 'manual',
      liquidity: 'usable_now',
      currency: 'VND',
      note: '',
      status: 'active',
      manualValue: 6_000_000_000,
    };
    const insertRevaluationEvent = jest.fn().mockResolvedValue(undefined);
    const repository = {
      assertHousehold: jest.fn().mockResolvedValue({ id: 'household-1' }),
      findAssetById: jest.fn().mockResolvedValue(current),
      updateAsset: jest.fn().mockResolvedValue(undefined),
      getFxRates: jest.fn().mockResolvedValue([]),
      createId: jest
        .fn()
        .mockReturnValueOnce('event-revaluation')
        .mockReturnValueOnce('valuation-revaluation'),
      insertRevaluationEvent,
      insertAssetValueHistory: jest.fn().mockResolvedValue(undefined),
      updateAssetCurrentValue: jest.fn().mockResolvedValue(undefined),
    } as unknown as AssetsRepository;
    const prisma = {
      runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
    } as unknown as PrismaService;
    const marketData = {
      getMarketPrices: jest.fn().mockResolvedValue([]),
    } as unknown as MarketDataService;
    const audit = { record: jest.fn() } as never;
    const service = new AssetsService(repository, prisma, marketData, audit);

    await service.updateAsset('household-1', current.id, {
      manualValue: 13_500_000,
    });

    expect(insertRevaluationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: current.id,
        amount: -5_986_500_000,
      }),
    );
  });

  describe('counts towards flexible money', () => {
    function harness(current?: Asset) {
      const insertAsset = jest.fn().mockResolvedValue(undefined);
      const updateAsset = jest.fn().mockResolvedValue(undefined);
      const repository = {
        assertHousehold: jest.fn().mockResolvedValue({ id: 'household-1' }),
        findAssetById: jest.fn().mockResolvedValue(current),
        createId: jest.fn(() => 'asset-new'),
        insertAsset,
        updateAsset,
        insertAssetValueHistory: jest.fn().mockResolvedValue(undefined),
        insertRevaluationEvent: jest.fn().mockResolvedValue(undefined),
        updateAssetCurrentValue: jest.fn().mockResolvedValue(undefined),
        getFxRates: jest.fn().mockResolvedValue([]),
      } as unknown as AssetsRepository;
      const prisma = {
        runInTransaction: jest.fn(async (work: () => Promise<unknown>) =>
          work(),
        ),
      } as unknown as PrismaService;
      const marketData = {
        getMarketPrices: jest.fn().mockResolvedValue([]),
      } as unknown as MarketDataService;
      const audit = { record: jest.fn() } as never;
      return {
        insertAsset,
        updateAsset,
        service: new AssetsService(repository, prisma, marketData, audit),
      };
    }

    it('lifts a long-term asset into usable_now when the household says so', async () => {
      const { service, insertAsset } = harness();

      const created = await service.createAsset('household-1', {
        name: 'Vàng SJC',
        type: 'gold',
        valuationMode: 'manual',
        manualValue: 80_000_000,
        countsAsFlexible: true,
      });

      // The stored bucket is what the forecast, the dashboard and the assets
      // summary all read — so the switch has to move THAT, not a private flag.
      expect(insertAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          liquidity: 'usable_now',
          countsAsFlexible: true,
        }),
      );
      expect(created.liquidity).toBe('usable_now');
    });

    it('drops excluded cash out of the flexible bucket', async () => {
      const { service, insertAsset } = harness();

      await service.createAsset('household-1', {
        name: 'Tiền giữ hộ',
        type: 'cash',
        valuationMode: 'manual',
        manualValue: 20_000_000,
        countsAsFlexible: false,
      });

      expect(insertAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          liquidity: 'not_immediately_usable',
          countsAsFlexible: false,
        }),
      );
    });

    it('stores no override when the answer matches the type default', async () => {
      const { service, insertAsset } = harness();

      await service.createAsset('household-1', {
        name: 'Ví tiền mặt',
        type: 'cash',
        valuationMode: 'manual',
        manualValue: 3_000_000,
        countsAsFlexible: true,
      });

      expect(insertAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          liquidity: 'usable_now',
          countsAsFlexible: null,
        }),
      );
    });

    it('keeps an existing override when the update does not mention it', async () => {
      const stored: Asset = {
        id: 'asset-cash',
        householdId: 'household-1',
        name: 'Tiền giữ hộ',
        type: 'cash',
        valuationMode: 'manual',
        liquidity: 'not_immediately_usable',
        countsAsFlexible: false,
        currency: 'VND',
        note: '',
        status: 'active',
        manualValue: 20_000_000,
      };
      const { service, updateAsset } = harness(stored);

      await service.updateAsset('household-1', stored.id, {
        name: 'Tiền giữ hộ mẹ',
      });

      expect(updateAsset).toHaveBeenCalledWith(
        stored.id,
        expect.objectContaining({
          liquidity: 'not_immediately_usable',
          countsAsFlexible: false,
        }),
      );
    });

    it('drops an override that the new type already implies', async () => {
      const stored: Asset = {
        id: 'asset-gold',
        householdId: 'household-1',
        name: 'Vàng',
        type: 'gold',
        valuationMode: 'manual',
        liquidity: 'usable_now',
        countsAsFlexible: true,
        currency: 'VND',
        note: '',
        status: 'active',
        manualValue: 80_000_000,
      };
      const { service, updateAsset } = harness(stored);

      await service.updateAsset('household-1', stored.id, { type: 'cash' });

      expect(updateAsset).toHaveBeenCalledWith(
        stored.id,
        expect.objectContaining({
          liquidity: 'usable_now',
          countsAsFlexible: null,
        }),
      );
    });
  });
});

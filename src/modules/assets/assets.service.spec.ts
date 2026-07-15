import { AssetsService } from './assets.service';
import type { Asset } from './entities/asset.entity';
import type { AssetValueHistory } from './entities/asset-value-history.entity';
import type { AssetsRepository } from './repositories/assets.repository.interface';
import type { PrismaService } from '../../database/prisma/prisma.service';
import type { SnapshotsService } from '../snapshots/snapshots.service';
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
    let snapshotAssetId: string | undefined;
    const onAssetChanged = jest.fn(
      (_householdId: string, assetId: string): Promise<void> => {
        snapshotAssetId = assetId;
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
    const snapshots = {
      onAssetChanged,
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

    await service.createAsset('household-1', {
      name: 'BTC mua thêm',
      type: 'crypto',
      valuationMode: 'market_priced',
      liquidity: 'long_term',
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
      note: 'Mua thêm 0,5 BTC btc',
    });
    expect(recordedPurchase?.isoDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(recordedValuation?.id).toBe('valuation-purchase');
    expect(recordedValuation?.assetId).toBe(existing.id);
    expect(recordedValuation?.moneyEventId).toBe('event-purchase');
    expect(snapshotAssetId).toBe(existing.id);
  });
});

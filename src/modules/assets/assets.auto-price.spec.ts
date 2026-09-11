import { AssetsService } from './assets.service';
import { noopAnalytics } from '../../common/analytics/test-support/analytics.fixture';
import {
  freeEntitlement,
  premiumEntitlement,
} from '../billing/test-support/entitlement.fixture';
import type { Entitlement } from '../billing/entities/entitlement.entity';

/**
 * The auto-price quota — decided once, when the asset is created.
 *
 * Creating a gold, stock or crypto asset is always allowed: blocking it would
 * block the balance sheet a Vietnamese household opens the app for, and they
 * would leave rather than pay. What Premium sells is the AUTOMATION, so the
 * first assets land automatic and everything after lands manual, created
 * exactly as asked either way.
 *
 * There is no endpoint to move automation between assets. Which ones are
 * automatic follows from what the household owns and when they added it;
 * making room means deleting an asset they no longer hold.
 */
function makeService(
  entitlement: Entitlement,
  options: { autoPricedIds?: string[] } = {},
) {
  const autoPricedIds = options.autoPricedIds ?? [];
  const insertAsset = jest.fn(async (_asset: { autoPriceEnabled?: boolean; valuationMode?: string }) => undefined);

  const repository = {
    assertHousehold: jest.fn(async () => ({}) as never),
    createId: () => 'asset-new',
    insertAsset,
    countAutoPricedAssets: jest.fn(async () => autoPricedIds.length),
    findActiveMarketAssetBySymbol: jest.fn(async () => undefined),
    upsertCurrentValuation: jest.fn(async () => undefined),
    insertAssetValueHistory: jest.fn(async () => undefined),
    updateAssetCurrentValue: jest.fn(async () => undefined),
    findAssetById: jest.fn(async () => ({
      id: 'asset-3',
      householdId: 'hh-1',
      name: 'SJC',
      type: 'gold',
      valuationMode: 'market_priced',
      liquidity: 'long_term',
      currency: 'VND',
      note: '',
      status: 'active',
      autoPriceEnabled: false,
    })),
    getFxRates: jest.fn(async () => []),
  } as never;

  const entitlements = {
    forHousehold: jest.fn(async () => entitlement),
  } as never;

  const service = new AssetsService(
    repository,
    { runInTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()) } as never,
    { getMarketPrices: jest.fn(async () => []) } as never,
    { record: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    entitlements,
    noopAnalytics(),
  );

  return { service, insertAsset };
}

const goldPayload = {
  name: 'SJC',
  type: 'gold' as const,
  valuationMode: 'market_priced' as const,
  marketPosition: {
    assetClass: 'gold' as const,
    symbol: 'SJC',
    quantity: 1,
    unit: 'luong',
    quoteCurrency: 'VND',
  },
};

describe('auto-price quota', () => {
  it('creates a market asset over the ceiling anyway, with automation OFF', async () => {
    const { service, insertAsset } = makeService(freeEntitlement(), {
      autoPricedIds: ['asset-1'],
    });

    await service.createAsset('hh-1', goldPayload);

    // The asset exists — that is the point. It simply is not automatic.
    expect(insertAsset).toHaveBeenCalled();
    expect(insertAsset.mock.calls[0]![0]).toMatchObject({
      autoPriceEnabled: false,
      valuationMode: 'market_priced',
    });
  });

  // Also covers getting a slot back: the ceiling counts live automatic assets,
  // so deleting one frees it for the next asset created.
  it('creates it WITH automation while the household is under its ceiling', async () => {
    const { service, insertAsset } = makeService(freeEntitlement(), {
      autoPricedIds: [],
    });

    await service.createAsset('hh-1', goldPayload);
    expect(insertAsset.mock.calls[0]![0]).toMatchObject({ autoPriceEnabled: true });
  });

  it('leaves a premium household unlimited', async () => {
    const { service, insertAsset } = makeService(premiumEntitlement(), {
      autoPricedIds: ['a', 'b', 'c', 'd', 'e'],
    });

    await service.createAsset('hh-1', goldPayload);
    expect(insertAsset.mock.calls[0]![0]).toMatchObject({ autoPriceEnabled: true });
  });
});

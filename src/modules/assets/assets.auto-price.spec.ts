import { AssetsService } from './assets.service';
import {
  freeEntitlement,
  premiumEntitlement,
} from '../billing/test-support/entitlement.fixture';
import type { Entitlement } from '../billing/entities/entitlement.entity';

/**
 * The auto-price quota — the one limit that never says no.
 *
 * Creating a gold, stock or crypto asset is always allowed: blocking it would
 * block the balance sheet a Vietnamese household opens the app for, and they
 * would leave rather than pay. What Premium sells is the AUTOMATION, so an
 * asset over the ceiling is created exactly as asked with automatic pricing
 * off.
 */
function makeService(
  entitlement: Entitlement,
  options: { autoPricedIds?: string[] } = {},
) {
  const autoPricedIds = options.autoPricedIds ?? [];
  const insertAsset = jest.fn(async (_asset: { autoPriceEnabled?: boolean; valuationMode?: string }) => undefined);
  const setAutoPriceEnabled = jest.fn(async () => undefined);

  const repository = {
    assertHousehold: jest.fn(async () => ({}) as never),
    createId: () => 'asset-new',
    insertAsset,
    setAutoPriceEnabled,
    countAutoPricedAssets: jest.fn(async () => autoPricedIds.length),
    findAutoPricedAssetIds: jest.fn(async () => autoPricedIds),
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
  );

  return { service, insertAsset, setAutoPriceEnabled };
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
  it('creates the third market asset anyway, with automation OFF', async () => {
    const { service, insertAsset } = makeService(freeEntitlement(), {
      autoPricedIds: ['asset-1', 'asset-2'],
    });

    await service.createAsset('hh-1', goldPayload);

    // The asset exists — that is the point. It simply is not automatic.
    expect(insertAsset).toHaveBeenCalled();
    expect(insertAsset.mock.calls[0]![0]).toMatchObject({
      autoPriceEnabled: false,
      valuationMode: 'market_priced',
    });
  });

  it('creates it WITH automation while the household is under its ceiling', async () => {
    const { service, insertAsset } = makeService(freeEntitlement(), {
      autoPricedIds: ['asset-1'],
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

  it('turning automation on at the ceiling turns the OLDEST one off, without a 402', async () => {
    // The household is moving the automation it already has, not asking for
    // more — so refusing would be the wrong answer, and would leave them to
    // work out what to switch off first.
    const { service, setAutoPriceEnabled } = makeService(freeEntitlement(), {
      autoPricedIds: ['asset-1', 'asset-2'],
    });

    const result = await service.setAutoPrice('hh-1', 'asset-3', true);

    expect(result).toMatchObject({ autoPriceEnabled: true, turnedOff: 'asset-1' });
    expect(setAutoPriceEnabled).toHaveBeenCalledWith('hh-1', 'asset-1', false);
    expect(setAutoPriceEnabled).toHaveBeenCalledWith('hh-1', 'asset-3', true);
  });
});

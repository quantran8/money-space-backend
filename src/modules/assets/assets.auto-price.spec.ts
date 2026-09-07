import { AssetsService } from './assets.service';
import { EntitlementService } from '../billing/entitlement.service';
import {
  freeEntitlement,
  premiumEntitlement,
} from '../billing/test-support/entitlement.fixture';
import type { Entitlement } from '../billing/entities/entitlement.entity';

/**
 * The auto-price quota.
 *
 * CREATING a gold, stock or crypto asset is always allowed: blocking it would
 * block the balance sheet a Vietnamese household opens the app for, and they
 * would leave rather than pay. What Premium sells is the AUTOMATION, so an
 * asset over the ceiling is created exactly as asked with automatic pricing
 * off — the first two are automatic, everything after is manual.
 *
 * Turning automation ON at the ceiling is a different question, and it IS
 * refused: nothing the household already automated is moved to manual behind
 * their back.
 */
function makeService(
  entitlement: Entitlement,
  options: { autoPricedIds?: string[]; assetIsAutomatic?: boolean } = {},
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
      autoPriceEnabled: options.assetIsAutomatic ?? false,
    })),
    getFxRates: jest.fn(async () => []),
  } as never;

  // `assertQuota` is the real implementation, not a stub: what these cases are
  // about is whether the ceiling is enforced, so a mock that always passed
  // would assert nothing.
  const entitlements = {
    forHousehold: jest.fn(async () => entitlement),
    assertQuota: new EntitlementService(
      {} as never,
      {} as never,
      {} as never,
    ).assertQuota,
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

  describe('turning automation on', () => {
    it('is refused at the ceiling, and moves nothing to manual', async () => {
      const { service, setAutoPriceEnabled } = makeService(freeEntitlement(), {
        autoPricedIds: ['asset-1', 'asset-2'],
      });

      await expect(service.setAutoPrice('hh-1', 'asset-3', true)).rejects.toThrow();
      // The two the household already automated are untouched — that is the
      // whole point of refusing rather than swapping.
      expect(setAutoPriceEnabled).not.toHaveBeenCalled();
    });

    it('carries the paywall reason so the client opens the right sheet', async () => {
      const { service } = makeService(freeEntitlement(), {
        autoPricedIds: ['asset-1', 'asset-2'],
      });

      await expect(
        service.setAutoPrice('hh-1', 'asset-3', true),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          premium: expect.objectContaining({ reason: 'auto_price_quota' }),
        }),
      });
    });

    it('is allowed while under the ceiling', async () => {
      const { service, setAutoPriceEnabled } = makeService(freeEntitlement(), {
        autoPricedIds: ['asset-1'],
      });

      const result = await service.setAutoPrice('hh-1', 'asset-3', true);

      expect(result).toMatchObject({ autoPriceEnabled: true });
      expect(setAutoPriceEnabled).toHaveBeenCalledWith('hh-1', 'asset-3', true);
    });

    it('is never gated for a premium household', async () => {
      const { service, setAutoPriceEnabled } = makeService(premiumEntitlement(), {
        autoPricedIds: ['a', 'b', 'c', 'd', 'e'],
      });

      await service.setAutoPrice('hh-1', 'asset-3', true);
      expect(setAutoPriceEnabled).toHaveBeenCalledWith('hh-1', 'asset-3', true);
    });
  });

  // Giving up automation must always work, or a household at its ceiling
  // could never rearrange which two assets are automatic.
  it('turning automation OFF is never gated', async () => {
    const { service, setAutoPriceEnabled } = makeService(freeEntitlement(), {
      autoPricedIds: ['asset-1', 'asset-2', 'asset-3'],
      // Already automatic, or there would be nothing to turn off.
      assetIsAutomatic: true,
    });

    await service.setAutoPrice('hh-1', 'asset-3', false);
    expect(setAutoPriceEnabled).toHaveBeenCalledWith('hh-1', 'asset-3', false);
  });
});

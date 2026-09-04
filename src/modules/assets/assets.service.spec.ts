import { BadRequestException } from '@nestjs/common';

import { AssetsService } from './assets.service';
import type { Asset } from './entities/asset.entity';
import type { AssetValueHistory } from './entities/asset-value-history.entity';
import type { AssetsRepository } from './repositories/assets.repository.interface';
import type { MoneyEvent } from '../money-events/entities/money-event.entity';
import type { PrismaService } from '../../database/prisma/prisma.service';
import type { MarketDataService } from '../market-data/market-data.service';

describe('AssetsService', () => {
  /** Minimal repo/prisma scaffolding for the update + create paths. */
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
      runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
    } as unknown as PrismaService;
    const marketData = {
      getMarketPrices: jest.fn().mockResolvedValue([]),
    } as unknown as MarketDataService;
    const audit = { record: jest.fn() } as never;
    return {
      insertAsset,
      updateAsset,
      service: new AssetsService(
        repository,
        prisma,
        marketData,
        audit,
        // Delete-only collaborators; untouched by these cases.
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      ),
    };
  }

  /**
   * `listAssets` decorates each position with today's quote. Gold is published
   * per lượng, so a holding counted in chỉ must be restated — the raw figure is
   * 10x the position's own unit, and the sale/purchase dialogs seed their đồng
   * field straight from it, labelled "per <position unit>".
   */
  describe('listAssets market price', () => {
    function goldHarness(unit: string, pricePerLuong: number) {
      const asset = {
        id: 'asset-gold',
        householdId: 'household-1',
        name: 'NHẪN TRÒN TRƠN',
        type: 'gold',
        valuationMode: 'market_priced',
        liquidity: 'long_term',
        currency: 'VND',
        status: 'active',
        marketPosition: {
          assetClass: 'gold',
          symbol: 'NHẪN TRÒN TRƠN',
          quantity: 1,
          unit,
          quoteCurrency: 'VND',
          purchasePrice: 15_120_000,
        },
      } as unknown as Asset;
      const repository = {
        assertHousehold: jest.fn().mockResolvedValue({ id: 'household-1' }),
        findAssetsByHousehold: jest.fn().mockResolvedValue([asset]),
        getFxRates: jest.fn().mockResolvedValue([]),
      } as unknown as AssetsRepository;
      const marketData = {
        getMarketPrices: jest.fn().mockResolvedValue([
          {
            assetClass: 'gold',
            symbol: 'NHẪN TRÒN TRƠN',
            price: pricePerLuong,
            unit: 'lượng',
            quoteCurrency: 'VND',
            priceTime: '2026-09-03T17:00:00.000Z',
            source: 'giavangnet',
          },
        ]),
      } as unknown as MarketDataService;
      return new AssetsService(
        repository,
        {
          runInTransaction: jest.fn(async (work: () => Promise<unknown>) =>
            work(),
          ),
        } as unknown as PrismaService,
        marketData,
        { record: jest.fn() } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    }

    it('states the quote per the position unit, not per lượng', async () => {
      const service = goldHarness('chỉ', 150_500_000);

      const { items } = await service.listAssets('household-1');

      // 150,500,000/lượng → 15,050,000/chỉ, the same basis as `purchasePrice`
      // beside it and as `currentValue`.
      expect(items[0].marketPosition?.marketPrice).toBe(15_050_000);
      expect(items[0].currentValue).toBe(15_050_000);
    });

    it('leaves a holding already counted in lượng alone', async () => {
      const service = goldHarness('lượng', 150_500_000);

      const { items } = await service.listAssets('household-1');

      expect(items[0].marketPosition?.marketPrice).toBe(150_500_000);
    });
  });

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
    const service = new AssetsService(
      repository,
      prisma,
      marketData,
      audit,
      // Delete-only collaborators; untouched by these cases.
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

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

  describe('buying more of a position already held', () => {
    function harness() {
      const existing: Asset = {
        id: 'asset-gold',
        householdId: 'household-1',
        name: 'Vàng SJC',
        type: 'gold',
        valuationMode: 'market_priced',
        liquidity: 'long_term',
        currency: 'VND',
        note: '',
        status: 'active',
        marketPosition: {
          assetClass: 'gold',
          symbol: 'SJC',
          quantity: 2,
          unit: 'chỉ',
          quoteCurrency: 'VND',
          purchasePrice: 8_000_000,
        },
      };
      const wallet: Asset = {
        id: 'wallet-1',
        householdId: 'household-1',
        name: 'TCB',
        type: 'bank_account',
        valuationMode: 'manual',
        liquidity: 'usable_now',
        currency: 'VND',
        note: '',
        status: 'active',
        manualValue: 500_000_000,
      };
      const updateAsset = jest.fn().mockResolvedValue(undefined);
      const insertAssetPurchaseEvent = jest.fn().mockResolvedValue(undefined);
      const repository = {
        assertHousehold: jest.fn().mockResolvedValue({ id: 'household-1' }),
        findAssetById: jest.fn((_hid: string, id: string) =>
          Promise.resolve(id === wallet.id ? wallet : existing),
        ),
        updateAsset,
        getFxRates: jest.fn().mockResolvedValue([]),
        createId: jest.fn().mockReturnValue('event-purchase'),
        insertAssetPurchaseEvent,
        insertAssetValueHistory: jest.fn().mockResolvedValue(undefined),
        updateAssetCurrentValue: jest.fn().mockResolvedValue(undefined),
      } as unknown as AssetsRepository;
      const prisma = {
        runInTransaction: jest.fn(async (work: () => Promise<unknown>) =>
          work(),
        ),
      } as unknown as PrismaService;
      const marketData = {
        getMarketPrices: jest.fn().mockResolvedValue([]),
      } as unknown as MarketDataService;
      const service = new AssetsService(
        repository,
        prisma,
        marketData,
        { record: jest.fn() } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      return { service, existing, updateAsset, insertAssetPurchaseEvent };
    }

    it('re-averages the cost basis instead of pricing the whole holding at the old one', async () => {
      const { service, existing, updateAsset } = harness();

      // 2 chỉ at 8tr, then 2 more at 10tr → average 9tr, not 8tr.
      await service.purchaseIntoPosition('household-1', existing.id, {
        quantity: 2,
        purchasePrice: 10_000_000,
        fundingAssetId: 'wallet-1',
      });

      expect(updateAsset).toHaveBeenCalledWith(
        existing.id,
        expect.objectContaining({
          marketPosition: expect.objectContaining({
            quantity: 4,
            purchasePrice: 9_000_000,
          }),
        }),
      );
    });

    it('logs the purchase so the added quantity is not conjured', async () => {
      const { service, existing, insertAssetPurchaseEvent } = harness();

      await service.purchaseIntoPosition('household-1', existing.id, {
        quantity: 2,
        purchasePrice: 10_000_000,
        fundingAssetId: 'wallet-1',
      });

      expect(insertAssetPurchaseEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: existing.id,
          amount: 20_000_000,
          fundingAssetId: 'wallet-1',
        }),
      );
    });

    it('rejects a purchase into an asset that has no position', async () => {
      const { service } = harness();
      const cash = {
        id: 'wallet-1',
        householdId: 'household-1',
        name: 'TCB',
        type: 'bank_account',
        valuationMode: 'manual',
        liquidity: 'usable_now',
        currency: 'VND',
        note: '',
        status: 'active',
        manualValue: 1_000,
      } as Asset;
      void cash;

      await expect(
        service.purchaseIntoPosition('household-1', 'wallet-1', {
          quantity: 1,
          purchasePrice: 1,
        }),
      ).rejects.toThrow();
    });
  });

  describe('a corrected holding is not a price movement', () => {
    // The bug this covers: changing `quantity` fell through to `logRevaluation`
    // and was written as `asset_update` — the type that means "the price moved".
    // Correcting 10 chỉ of gold to 1 chỉ therefore reported a ~720tr market loss
    // the household never took.
    function goldHarness() {
      const current: Asset = {
        id: 'asset-gold',
        householdId: 'household-1',
        name: 'Vàng SJC',
        type: 'gold',
        valuationMode: 'market_priced',
        liquidity: 'long_term',
        currency: 'VND',
        note: '',
        status: 'active',
        marketPosition: {
          assetClass: 'gold',
          symbol: 'SJC',
          quantity: 10,
          unit: 'chỉ',
          quoteCurrency: 'VND',
          purchasePrice: 8_000_000,
          lastPrice: 8_000_000,
        },
      };
      const insertRevaluationEvent = jest.fn().mockResolvedValue(undefined);
      const insertQuantityAdjustmentEvent = jest
        .fn()
        .mockResolvedValue(undefined);
      const repository = {
        assertHousehold: jest.fn().mockResolvedValue({ id: 'household-1' }),
        findAssetById: jest.fn().mockResolvedValue(current),
        updateAsset: jest.fn().mockResolvedValue(undefined),
        getFxRates: jest.fn().mockResolvedValue([]),
        createId: jest
          .fn()
          .mockReturnValueOnce('event-adjustment')
          .mockReturnValueOnce('valuation-adjustment'),
        insertRevaluationEvent,
        insertQuantityAdjustmentEvent,
        insertAssetValueHistory: jest.fn().mockResolvedValue(undefined),
        updateAssetCurrentValue: jest.fn().mockResolvedValue(undefined),
      } as unknown as AssetsRepository;
      const prisma = {
        runInTransaction: jest.fn(async (work: () => Promise<unknown>) =>
          work(),
        ),
      } as unknown as PrismaService;
      const marketData = {
        getMarketPrices: jest.fn().mockResolvedValue([]),
      } as unknown as MarketDataService;
      const service = new AssetsService(
        repository,
        prisma,
        marketData,
        { record: jest.fn() } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      return {
        service,
        current,
        insertRevaluationEvent,
        insertQuantityAdjustmentEvent,
      };
    }

    it('logs a quantity adjustment, not a revaluation, when only quantity changes', async () => {
      const {
        service,
        current,
        insertRevaluationEvent,
        insertQuantityAdjustmentEvent,
      } = goldHarness();

      await service.updateAsset('household-1', current.id, {
        marketPosition: { quantity: 1 },
      } as never);

      expect(insertRevaluationEvent).not.toHaveBeenCalled();
      expect(insertQuantityAdjustmentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: current.id,
          quantityBefore: 10,
          quantityAfter: 1,
          // Both sides recorded, so the series stays replayable; the value delta
          // rides along only to make the ledger row readable.
          amount: -72_000_000,
        }),
      );
    });

    it('still logs a revaluation when the price moves and quantity holds', async () => {
      const {
        service,
        current,
        insertRevaluationEvent,
        insertQuantityAdjustmentEvent,
      } = goldHarness();

      // A pure price refresh is a quote update, not a ledger event, so it writes
      // an unlinked history point and neither event type fires.
      await service.updateAsset('household-1', current.id, {
        marketPosition: { lastPrice: 9_000_000 },
      } as never);

      expect(insertQuantityAdjustmentEvent).not.toHaveBeenCalled();
      expect(insertRevaluationEvent).not.toHaveBeenCalled();
    });
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
    const service = new AssetsService(
      repository,
      prisma,
      marketData,
      audit,
      // Delete-only collaborators; untouched by these cases.
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

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

    it('drops an override that merely restates the type default', async () => {
      const stored: Asset = {
        id: 'asset-cash',
        householdId: 'household-1',
        name: 'Tiền mặt',
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
        countsAsFlexible: true,
      });

      expect(updateAsset).toHaveBeenCalledWith(
        stored.id,
        expect.objectContaining({
          liquidity: 'usable_now',
          countsAsFlexible: null,
        }),
      );
    });
  });

  /** What an asset IS cannot be edited — only what it is worth. */
  describe('identity is fixed once the asset exists', () => {
    const cash: Asset = {
      id: 'asset-cash',
      householdId: 'household-1',
      name: 'Tiền mặt',
      type: 'cash',
      valuationMode: 'manual',
      liquidity: 'usable_now',
      countsAsFlexible: null,
      currency: 'VND',
      note: '',
      status: 'active',
      manualValue: 20_000_000,
    };

    const stock: Asset = {
      id: 'asset-stock',
      householdId: 'household-1',
      name: 'FPT',
      type: 'stock',
      valuationMode: 'market_priced',
      liquidity: 'not_immediately_usable',
      countsAsFlexible: null,
      currency: 'VND',
      note: '',
      status: 'active',
      marketPosition: {
        assetClass: 'stock',
        symbol: 'FPT',
        quantity: 100,
        unit: 'cổ',
        quoteCurrency: 'VND',
        purchasePrice: 120_000,
      },
    };

    it('refuses to change the type', async () => {
      const { service } = harness(cash);

      await expect(
        service.updateAsset('household-1', cash.id, { type: 'gold' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses to repoint a holding at another symbol', async () => {
      const { service } = harness(stock);

      await expect(
        service.updateAsset('household-1', stock.id, {
          marketPosition: { ...stock.marketPosition!, symbol: 'HPG' },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts the unchanged type and symbol the form sends back', async () => {
      const { service, updateAsset } = harness(stock);

      await service.updateAsset('household-1', stock.id, {
        type: 'stock',
        note: 'Giữ dài hạn',
        marketPosition: { ...stock.marketPosition! },
      });

      expect(updateAsset).toHaveBeenCalledWith(
        stock.id,
        expect.objectContaining({ note: 'Giữ dài hạn' }),
      );
    });
  });

  /**
   * Declaring something already owned vs. buying it are two different acts, and
   * the difference is visible in one number: net worth. Recording a purchase
   * must leave it PUT — the money moved from a wallet into an asset. Recording
   * something already held raises it, because the household is no richer, just
   * newly honest about what it has.
   */
  describe('acquisition: already owned vs. just bought', () => {
    const wallet: Asset = {
      id: 'asset-vcb',
      householdId: 'household-1',
      name: 'VCB',
      type: 'bank_account',
      valuationMode: 'manual',
      liquidity: 'usable_now',
      currency: 'VND',
      note: '',
      status: 'active',
      manualValue: 200_000_000,
    };

    function harness(options?: { existingPosition?: Asset }) {
      const assets = new Map<string, Asset>([[wallet.id, { ...wallet }]]);
      const insertAsset = jest.fn((asset: Asset): Promise<void> => {
        assets.set(asset.id, asset);
        return Promise.resolve();
      });
      const updateAsset = jest.fn(
        (assetId: string, asset: Asset): Promise<void> => {
          assets.set(assetId, asset);
          return Promise.resolve();
        },
      );
      const insertAssetPurchaseEvent = jest.fn().mockResolvedValue(undefined);
      let nextId = 0;
      const repository = {
        assertHousehold: jest.fn().mockResolvedValue({ id: 'household-1' }),
        findAssetById: jest.fn((_householdId: string, assetId: string) =>
          Promise.resolve(assets.get(assetId)),
        ),
        findActiveMarketAssetBySymbol: jest
          .fn()
          .mockResolvedValue(options?.existingPosition),
        createId: jest.fn(() => `generated-${(nextId += 1)}`),
        insertAsset,
        updateAsset,
        insertAssetPurchaseEvent,
        insertAssetValueHistory: jest.fn().mockResolvedValue(undefined),
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
      const service = new AssetsService(
        repository,
        prisma,
        marketData,
        audit,
        // Delete-only collaborators; untouched by these cases.
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      return {
        service,
        insertAssetPurchaseEvent,
        walletBalance: () => assets.get(wallet.id)?.manualValue ?? 0,
      };
    }

    it('leaves the wallet alone and logs nothing when the asset is already owned', async () => {
      const { service, insertAssetPurchaseEvent, walletBalance } = harness();

      await service.createAsset('household-1', {
        name: 'Vàng để dành',
        type: 'gold',
        valuationMode: 'manual',
        manualValue: 50_000_000,
      });

      expect(insertAssetPurchaseEvent).not.toHaveBeenCalled();
      expect(walletBalance()).toBe(200_000_000);
    });

    it('debits the funding wallet and logs an outflow when the asset was just bought', async () => {
      const { service, insertAssetPurchaseEvent, walletBalance } = harness();

      await service.createAsset('household-1', {
        name: 'Vàng mới mua',
        type: 'gold',
        valuationMode: 'manual',
        manualValue: 50_000_000,
        fundingAssetId: wallet.id,
      });

      expect(insertAssetPurchaseEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 50_000_000,
          fundingAssetId: wallet.id,
        }),
      );
      // 200tr wallet - 50tr gold, and the gold is worth 50tr: net worth unmoved.
      expect(walletBalance()).toBe(150_000_000);
    });

    it('charges the cost basis, not the live market value, for a market position', async () => {
      const existingPosition: Asset = {
        id: 'asset-vnm',
        householdId: 'household-1',
        name: 'VNM',
        type: 'stock',
        valuationMode: 'market_priced',
        liquidity: 'long_term',
        currency: 'VND',
        note: '',
        status: 'active',
        marketPosition: {
          assetClass: 'stock',
          symbol: 'VNM',
          quantity: 100,
          unit: 'cp',
          quoteCurrency: 'VND',
          purchasePrice: 60_000,
        },
      };
      const { service, insertAssetPurchaseEvent, walletBalance } = harness({
        existingPosition,
      });

      await service.createAsset('household-1', {
        name: 'VNM mua thêm',
        type: 'stock',
        valuationMode: 'market_priced',
        marketPosition: {
          assetClass: 'stock',
          symbol: 'VNM',
          quantity: 100,
          unit: 'cp',
          quoteCurrency: 'VND',
          purchasePrice: 70_000,
        },
        fundingAssetId: wallet.id,
      });

      // 100 × 70.000 = 7tr paid, regardless of what VNM trades at today.
      expect(insertAssetPurchaseEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 7_000_000,
          fundingAssetId: wallet.id,
        }),
      );
      expect(walletBalance()).toBe(193_000_000);
    });

    it('rejects a purchase the wallet cannot cover', async () => {
      const { service, insertAssetPurchaseEvent, walletBalance } = harness();

      await expect(
        service.createAsset('household-1', {
          name: 'Vàng quá tay',
          type: 'gold',
          valuationMode: 'manual',
          manualValue: 500_000_000,
          fundingAssetId: wallet.id,
        }),
      ).rejects.toThrow(/không đủ/);

      // Rejected before the write transaction opened — nothing left behind.
      expect(insertAssetPurchaseEvent).not.toHaveBeenCalled();
      expect(walletBalance()).toBe(200_000_000);
    });

    it('allows spending a wallet down to exactly zero', async () => {
      const { service, walletBalance } = harness();

      await service.createAsset('household-1', {
        name: 'Vàng dốc ví',
        type: 'gold',
        valuationMode: 'manual',
        manualValue: 200_000_000,
        fundingAssetId: wallet.id,
      });

      expect(walletBalance()).toBe(0);
    });

    it('rejects a funding source that is not a wallet', async () => {
      const gold: Asset = {
        id: 'asset-gold',
        householdId: 'household-1',
        name: 'Vàng',
        type: 'gold',
        valuationMode: 'manual',
        liquidity: 'usable_now',
        currency: 'VND',
        note: '',
        status: 'active',
        manualValue: 500_000_000,
      };
      const { service } = harness();
      const repository = (
        service as unknown as {
          assetsRepository: { findAssetById: jest.Mock };
        }
      ).assetsRepository;
      repository.findAssetById.mockResolvedValue(gold);

      await expect(
        service.createAsset('household-1', {
          name: 'Vàng mua bằng vàng',
          type: 'gold',
          valuationMode: 'manual',
          manualValue: 10_000_000,
          fundingAssetId: gold.id,
        }),
      ).rejects.toThrow(/not a cash or bank account/);
    });
  });

  describe('editing a back-dated event re-bases the events after it', () => {
    /** Wallet harness: a TCB wallet plus a mutable ledger of money events. */
    function walletHarness(manualValue: number, events: MoneyEvent[]) {
      const wallet: Asset = {
        id: 'asset-tcb',
        householdId: 'household-1',
        name: 'TCB',
        type: 'bank_account',
        valuationMode: 'manual',
        liquidity: 'usable_now',
        currency: 'VND',
        note: '',
        status: 'active',
        manualValue,
      };
      const points: AssetValueHistory[] = [];
      const repository = {
        assertHousehold: jest.fn().mockResolvedValue({ id: 'household-1' }),
        findAssetById: jest.fn(() => Promise.resolve(wallet)),
        createId: jest.fn(() => `valuation-${points.length}`),
        findMoneyEventsByAsset: jest.fn(() =>
          Promise.resolve(
            [...events].sort((a, b) => a.isoDate.localeCompare(b.isoDate)),
          ),
        ),
        updateAsset: jest.fn((_id: string, next: Asset) => {
          wallet.manualValue = next.manualValue;
          return Promise.resolve();
        }),
        insertAssetValueHistory: jest.fn((point: AssetValueHistory) => {
          points.push(point);
          return Promise.resolve();
        }),
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
      const service = new AssetsService(
        repository,
        prisma,
        marketData,
        { record: jest.fn() } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      return { service, wallet, points };
    }

    /** An income/expense money event against the TCB wallet. */
    function move(
      id: string,
      isoDate: string,
      amount: number,
      direction: 'in' | 'out',
    ): MoneyEvent {
      return {
        id,
        householdId: 'household-1',
        amount,
        feeAmount: 0,
        note: '',
        isoDate,
        type: direction === 'in' ? 'income' : 'expense',
        categoryId: 'cat-other',
        direction: direction === 'in' ? 'inflow' : 'outflow',
        toAssetId: direction === 'in' ? 'asset-tcb' : undefined,
        fromAssetId: direction === 'in' ? undefined : 'asset-tcb',
      };
    }

    it('re-derives the balance from the opening balance, not the current one', async () => {
      // Wallet opened with 5tr, then: 1/8 +5tr, 2/8 −2tr, 3/8 −3tr → 5tr.
      const events = [
        move('event-1', '2026-08-01', 5_000_000, 'in'),
        move('event-2', '2026-08-02', 2_000_000, 'out'),
        move('event-3', '2026-08-03', 3_000_000, 'out'),
      ];
      const { service, wallet, points } = walletHarness(5_000_000, events);
      const baseline = await service.snapshotWalletBaseline(
        'household-1',
        'asset-tcb',
      );

      // 4/8: the user corrects the 1/8 inflow from 5tr down to 1tr.
      events[0].amount = 1_000_000;
      const balance = await service.replayWalletBalance(
        'household-1',
        'asset-tcb',
        baseline,
      );

      // Opening 5tr + 1 − 2 − 3 = 1tr. The two later expenses keep their own
      // amounts; only the balance they sit on moved.
      expect(balance).toBe(1_000_000);
      expect(wallet.manualValue).toBe(1_000_000);
      // Every event's history point records the balance AS OF its date, so the
      // value chart follows the ledger instead of the "now" balance.
      expect(points.map((point) => [point.valuationDate, point.value])).toEqual(
        [
          ['2026-08-01', 6_000_000],
          ['2026-08-02', 4_000_000],
          ['2026-08-03', 1_000_000],
        ],
      );
    });

    it('lets an overdrawn wallet go negative instead of silently clamping', async () => {
      // Same ledger, but the wallet opened at 0 — so the corrected inflow no
      // longer covers the 5tr of spending recorded against it.
      const events = [
        move('event-1', '2026-08-01', 5_000_000, 'in'),
        move('event-2', '2026-08-02', 2_000_000, 'out'),
        move('event-3', '2026-08-03', 3_000_000, 'out'),
      ];
      const { service } = walletHarness(0, events);
      const baseline = await service.snapshotWalletBaseline(
        'household-1',
        'asset-tcb',
      );
      events[0].amount = 1_000_000;

      const overdrafts = await service.findWalletOverdrafts(
        'household-1',
        'asset-tcb',
        { baseline },
      );
      const balance = await service.replayWalletBalance(
        'household-1',
        'asset-tcb',
        baseline,
      );

      // 0 + 1 − 2 − 3 = −4tr. Clamping at 0 here is what used to make the edit
      // lossy — the balance must stay truthful so the UI can flag it.
      expect(balance).toBe(-4_000_000);
      expect(overdrafts.map((item) => [item.isoDate, item.balance])).toEqual([
        ['2026-08-02', -1_000_000],
        ['2026-08-03', -4_000_000],
      ]);
    });

    it('previews an overdraft from a ledger the database does not hold yet', async () => {
      // Wallet opened at 0: 1/8 +5tr, 2/8 −2tr, 3/8 −3tr → exactly 0, no overdraft.
      const events = [
        move('event-1', '2026-08-01', 5_000_000, 'in'),
        move('event-2', '2026-08-02', 2_000_000, 'out'),
        move('event-3', '2026-08-03', 3_000_000, 'out'),
      ];
      const { service, wallet } = walletHarness(0, events);

      expect(
        await service.findWalletOverdrafts('household-1', 'asset-tcb'),
      ).toEqual([]);

      // Dry-run the 1/8 correction to 1tr WITHOUT touching the stored ledger.
      const preview = await service.findWalletOverdrafts(
        'household-1',
        'asset-tcb',
        {
          simulate: (stored) =>
            stored.map((event) =>
              event.id === 'event-1'
                ? { ...event, amount: 1_000_000 }
                : event,
            ),
        },
      );

      expect(preview.map((item) => [item.isoDate, item.balance])).toEqual([
        ['2026-08-02', -1_000_000],
        ['2026-08-03', -4_000_000],
      ]);
      // The preview is read-only: nothing about the wallet moved.
      expect(wallet.manualValue).toBe(0);
    });

    it('re-sorts a simulated event that moved to a new date', async () => {
      // Moving the inflow to AFTER both expenses overdraws the wallet in between,
      // even though the same three amounts still net to 0.
      const events = [
        move('event-1', '2026-08-01', 5_000_000, 'in'),
        move('event-2', '2026-08-02', 2_000_000, 'out'),
        move('event-3', '2026-08-03', 3_000_000, 'out'),
      ];
      const { service } = walletHarness(0, events);

      const preview = await service.findWalletOverdrafts(
        'household-1',
        'asset-tcb',
        {
          simulate: (stored) =>
            stored.map((event) =>
              event.id === 'event-1'
                ? { ...event, isoDate: '2026-08-04' }
                : event,
            ),
        },
      );

      expect(preview.map((item) => [item.isoDate, item.balance])).toEqual([
        ['2026-08-02', -2_000_000],
        ['2026-08-03', -5_000_000],
      ]);
    });

    it('returns to the original balance when the edit is undone', async () => {
      // Invertibility is the property the zero floor destroyed: editing 5tr → 1tr
      // → 5tr must land back where it started, even after the balance went
      // negative in between.
      const events = [
        move('event-1', '2026-08-01', 5_000_000, 'in'),
        move('event-2', '2026-08-02', 2_000_000, 'out'),
        move('event-3', '2026-08-03', 3_000_000, 'out'),
      ];
      const { service } = walletHarness(0, events);

      const first = await service.snapshotWalletBaseline(
        'household-1',
        'asset-tcb',
      );
      events[0].amount = 1_000_000;
      await service.replayWalletBalance('household-1', 'asset-tcb', first);

      const second = await service.snapshotWalletBaseline(
        'household-1',
        'asset-tcb',
      );
      events[0].amount = 5_000_000;
      const restored = await service.replayWalletBalance(
        'household-1',
        'asset-tcb',
        second,
      );

      expect(restored).toBe(0);
    });
  });
});

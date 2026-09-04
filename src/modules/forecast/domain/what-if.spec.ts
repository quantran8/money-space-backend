import { applyAssetSale, isSellableForecastAsset } from './what-if';
import type { ForecastLiquidSource } from './forecast.types';

const M = 1_000_000;

function asset(over: Partial<ForecastLiquidSource> = {}): ForecastLiquidSource {
  return {
    assetId: 'a1',
    name: 'VCB',
    value: 10 * M,
    liquidity: 'usable_now',
    type: 'bank_account',
    valueUpdatedAt: '2026-09-03',
    ...over,
  };
}

describe('isSellableForecastAsset', () => {
  it('accepts a long-term asset of a sellable type', () => {
    expect(
      isSellableForecastAsset(asset({ type: 'stock', liquidity: 'long_term' })),
    ).toBe(true);
  });

  it('refuses a wallet: money moves out of one by a transfer, not a sale', () => {
    expect(isSellableForecastAsset(asset({ type: 'cash' }))).toBe(false);
    expect(isSellableForecastAsset(asset({ type: 'bank_account' }))).toBe(
      false,
    );
  });

  it('refuses a non-sellable type even when it is not usable now', () => {
    for (const type of ['insurance', 'saving_deposit', 'other'] as const) {
      expect(
        isSellableForecastAsset(asset({ type, liquidity: 'long_term' })),
      ).toBe(false);
    }
  });
});

describe('applyAssetSale', () => {
  const assets = [
    asset({ assetId: 'wallet', value: 100 * M }),
    asset({
      assetId: 'stock',
      value: 600 * M,
      type: 'stock',
      liquidity: 'long_term',
    }),
  ];

  it('moves value from the sold asset into the receiving wallet', () => {
    const next = applyAssetSale(assets, {
      assetId: 'stock',
      amount: 300 * M,
      receivingAssetId: 'wallet',
    });

    expect(next.find((a) => a.assetId === 'stock')?.value).toBe(300 * M);
    expect(next.find((a) => a.assetId === 'wallet')?.value).toBe(400 * M);
  });

  it('creates no net worth: a sale is a conversion, not income', () => {
    const total = (list: ForecastLiquidSource[]) =>
      list.reduce((sum, a) => sum + a.value, 0);
    const next = applyAssetSale(assets, {
      assetId: 'stock',
      amount: 300 * M,
      receivingAssetId: 'wallet',
    });

    expect(total(next)).toBe(total(assets));
  });

  it('does not mutate the caller’s array', () => {
    applyAssetSale(assets, {
      assetId: 'stock',
      amount: 300 * M,
      receivingAssetId: 'wallet',
    });

    expect(assets.find((a) => a.assetId === 'stock')?.value).toBe(600 * M);
  });
});

import {
  applyAssetSale,
  isSellableForecastAsset,
  UNASSIGNED_WALLET_ID,
} from './what-if';
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
    asset({
      assetId: 'gold',
      value: 300 * M,
      type: 'gold',
      liquidity: 'not_immediately_usable',
    }),
  ];

  const oneLine = {
    lines: [{ assetId: 'stock', amount: 300 * M }],
    amount: 300 * M,
    receivingAssetId: 'wallet',
  };

  it('moves value from the sold asset into the receiving wallet', () => {
    const next = applyAssetSale(assets, oneLine);

    expect(next.find((a) => a.assetId === 'stock')?.value).toBe(300 * M);
    expect(next.find((a) => a.assetId === 'wallet')?.value).toBe(400 * M);
  });

  it('sells several holdings into one wallet', () => {
    const next = applyAssetSale(assets, {
      lines: [
        { assetId: 'stock', amount: 200 * M },
        { assetId: 'gold', amount: 250 * M },
      ],
      amount: 450 * M,
      receivingAssetId: 'wallet',
    });

    expect(next.find((a) => a.assetId === 'stock')?.value).toBe(400 * M);
    expect(next.find((a) => a.assetId === 'gold')?.value).toBe(50 * M);
    expect(next.find((a) => a.assetId === 'wallet')?.value).toBe(550 * M);
  });

  it('creates no net worth: a sale is a conversion, not income', () => {
    const total = (list: ForecastLiquidSource[]) =>
      list.reduce((sum, a) => sum + a.value, 0);
    const next = applyAssetSale(assets, oneLine);

    expect(total(next)).toBe(total(assets));
  });

  it('holds the proceeds as usable money when no wallet receives them', () => {
    const walletless = assets.filter((a) => a.assetId !== 'wallet');
    const next = applyAssetSale(walletless, {
      lines: [{ assetId: 'stock', amount: 300 * M }],
      amount: 300 * M,
      receivingAssetId: null,
    });

    const proceeds = next.find((a) => a.assetId === UNASSIGNED_WALLET_ID);
    expect(proceeds?.value).toBe(300 * M);
    expect(proceeds?.liquidity).toBe('usable_now');
    // Still a conversion — the household is no richer for having sold.
    expect(next.reduce((sum, a) => sum + a.value, 0)).toBe(
      walletless.reduce((sum, a) => sum + a.value, 0),
    );
  });

  it('does not mutate the caller’s array', () => {
    applyAssetSale(assets, oneLine);

    expect(assets.find((a) => a.assetId === 'stock')?.value).toBe(600 * M);
  });
});

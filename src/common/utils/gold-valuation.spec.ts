import { computeCurrentValue } from './money-space.utils';
import type { Asset } from '../../modules/assets/entities/asset.entity';
import type { MarketPrice } from '../../modules/market-data/entities/market-price.entity';

/**
 * A gold holding valued from the shared market cache. The feed quotes one
 * figure per lượng, so a holding counted in chỉ or gram must be restated before
 * it meets `quantity` — the frontend divided while the backend did not, and the
 * two disagreed by exactly the unit's ratio.
 */
describe('computeCurrentValue — gold unit conversion', () => {
  const PER_LUONG = 12_000_000;

  const quote: MarketPrice = {
    assetClass: 'gold',
    symbol: 'VÀNG MIẾNG SJC',
    price: PER_LUONG,
    unit: 'lượng',
    quoteCurrency: 'VND',
    priceTime: '2026-08-31T00:00:00.000Z',
    source: 'giavangnet',
  };

  const goldAsset = (quantity: number, unit: string): Asset => ({
    id: 'a1',
    householdId: 'h1',
    name: 'VÀNG MIẾNG SJC',
    type: 'gold',
    valuationMode: 'market_priced',
    liquidity: 'usable_now',
    currency: 'VND',
    note: '',
    status: 'active',
    marketPosition: {
      assetClass: 'gold',
      symbol: 'VÀNG MIẾNG SJC',
      quantity,
      unit,
      quoteCurrency: 'VND',
    },
  });

  const valueOf = (asset: Asset) =>
    computeCurrentValue(asset, [quote], [], '2026-08-31');

  it('values a holding in lượng at the quoted price', () => {
    expect(valueOf(goldAsset(2, 'lượng'))).toBe(2 * PER_LUONG);
  });

  it('values a holding in chỉ at a tenth of the per-lượng price', () => {
    expect(valueOf(goldAsset(10, 'chỉ'))).toBe(PER_LUONG);
  });

  it('values a holding in gram at 1/37.5 of the per-lượng price', () => {
    expect(valueOf(goldAsset(37.5, 'gram'))).toBeCloseTo(PER_LUONG, 6);
  });

  // The regression: 5 chỉ is half a lượng, not five of them.
  it('does not value chỉ at the per-lượng figure', () => {
    expect(valueOf(goldAsset(5, 'chỉ'))).toBe(PER_LUONG / 2);
  });

  it('leaves a non-gold position untouched by the unit rules', () => {
    const stock: Asset = {
      ...goldAsset(10, 'chỉ'),
      type: 'stock',
      marketPosition: {
        assetClass: 'stock',
        symbol: 'VNM',
        quantity: 10,
        unit: 'cổ',
        quoteCurrency: 'VND',
      },
    };
    const stockQuote: MarketPrice = {
      ...quote,
      assetClass: 'stock',
      symbol: 'VNM',
      price: 60_000,
      unit: 'cổ',
    };
    expect(computeCurrentValue(stock, [stockQuote], [], '2026-08-31')).toBe(
      600_000,
    );
  });
});

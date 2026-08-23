import {
  deriveDirection,
  liquidityForAsset,
  liquidityForAssetType,
  marketUnitForAssetType,
  normalizeCountsAsFlexible,
} from './money-space.utils';

describe('liquidityForAssetType', () => {
  it.each([
    ['cash', 'usable_now'],
    ['bank_account', 'usable_now'],
    ['saving_deposit', 'not_immediately_usable'],
    ['certificate_of_deposit', 'not_immediately_usable'],
    ['bond', 'not_immediately_usable'],
    ['loan_receivable', 'not_immediately_usable'],
    ['foreign_currency', 'not_immediately_usable'],
    ['other', 'not_immediately_usable'],
    ['gold', 'long_term'],
    ['stock', 'long_term'],
    ['fund', 'long_term'],
    ['crypto', 'long_term'],
    ['real_estate', 'long_term'],
    ['insurance', 'long_term'],
    ['investment', 'long_term'],
  ] as const)('maps %s to %s', (type, expected) => {
    expect(liquidityForAssetType(type)).toBe(expected);
  });
});

describe('liquidityForAsset', () => {
  it('follows the type when the household made no decision', () => {
    expect(liquidityForAsset('gold', null)).toBe('long_term');
    expect(liquidityForAsset('cash', undefined)).toBe('usable_now');
  });

  it('lifts any type into usable_now when it is counted as flexible', () => {
    expect(liquidityForAsset('gold', true)).toBe('usable_now');
    expect(liquidityForAsset('saving_deposit', true)).toBe('usable_now');
    expect(liquidityForAsset('real_estate', true)).toBe('usable_now');
  });

  it('drops excluded cash to the middle bucket, never to long_term', () => {
    expect(liquidityForAsset('cash', false)).toBe('not_immediately_usable');
    expect(liquidityForAsset('bank_account', false)).toBe(
      'not_immediately_usable',
    );
  });

  it('leaves a type that was never flexible where it already sits', () => {
    expect(liquidityForAsset('gold', false)).toBe('long_term');
    expect(liquidityForAsset('bond', false)).toBe('not_immediately_usable');
  });
});

describe('normalizeCountsAsFlexible', () => {
  it('stores only real overrides', () => {
    expect(normalizeCountsAsFlexible('cash', false)).toBe(false);
    expect(normalizeCountsAsFlexible('gold', true)).toBe(true);
  });

  it('drops a flag that merely restates the type default', () => {
    expect(normalizeCountsAsFlexible('cash', true)).toBeNull();
    expect(normalizeCountsAsFlexible('gold', false)).toBeNull();
  });

  it('treats an absent answer as no decision', () => {
    expect(normalizeCountsAsFlexible('cash', undefined)).toBeNull();
    expect(normalizeCountsAsFlexible('gold', null)).toBeNull();
  });
});

describe('marketUnitForAssetType', () => {
  it.each([
    ['stock', 'FPT', 'ignored', 'cổ'],
    ['crypto', ' btc ', 'ignored', 'BTC'],
    ['foreign_currency', ' usd ', 'ignored', 'USD'],
    ['fund', 'VN30', 'ignored', 'chứng chỉ'],
    ['gold', 'SJC', ' chỉ ', 'chỉ'],
  ] as const)('derives the unit for %s', (type, symbol, entered, expected) => {
    expect(marketUnitForAssetType(type, symbol, entered)).toBe(expected);
  });
});

describe('deriveDirection', () => {
  it.each([
    ['income', 'inflow'],
    ['expense', 'outflow'],
    ['debt_update', 'outflow'],
    // Completing an outgoing cashflow event: money left the household, so it
    // has to reach the month's chi and the debt's repaid total, both of which
    // sum by direction.
    ['payment_paid', 'outflow'],
    ['adjustment', 'neutral'],
    ['transfer', 'neutral'],
  ] as const)('derives %s as %s', (type, expected) => {
    expect(deriveDirection(type)).toBe(expected);
  });

  it('keeps an explicit direction over the type default', () => {
    expect(deriveDirection('payment_paid', 'neutral')).toBe('neutral');
  });
});

import {
  isVietnameseEquity,
  priceOverrides,
  priceRoutes,
  symbolReferenceRoutes,
} from './provider-routing';
import type { PriceProvider } from './price-provider.interface';
import type { SymbolReferenceProvider } from './symbol-reference-provider.interface';

const twelveData = { id: 'twelveData' } as unknown as PriceProvider;
const coinMarketCap = { id: 'coinMarketCap' } as unknown as PriceProvider;
const commodity = { id: 'commodity' } as unknown as PriceProvider;
const priceProviders = { twelveData, coinMarketCap, commodity };

const refTwelveData = {
  id: 'twelveData',
} as unknown as SymbolReferenceProvider;
const refCoinMarketCap = {
  id: 'coinMarketCap',
} as unknown as SymbolReferenceProvider;
const refVnstock = { id: 'vnstock' } as unknown as SymbolReferenceProvider;
const refCommodity = { id: 'commodity' } as unknown as SymbolReferenceProvider;
const refProviders = {
  twelveData: refTwelveData,
  coinMarketCap: refCoinMarketCap,
  vnstock: refVnstock,
  commodity: refCommodity,
};

describe('priceRoutes', () => {
  it('still routes gold and FX when no key is configured', () => {
    const routes = priceRoutes({}, priceProviders);

    // The commodity feed needs no key, so these two never depend on one.
    expect(routes.get('gold')).toBe(commodity);
    expect(routes.get('foreign_currency')).toBe(commodity);
    expect(routes.get('stock')).toBeUndefined();
    expect(routes.get('crypto')).toBeUndefined();
  });

  it('sends crypto to CoinMarketCap and equities to Twelve Data', () => {
    const routes = priceRoutes(
      { twelveData: 'td', coinMarketCap: 'cmc' },
      priceProviders,
    );

    expect(routes.get('crypto')).toBe(coinMarketCap);
    expect(routes.get('stock')).toBe(twelveData);
    expect(routes.get('fund')).toBe(twelveData);
  });

  it('leaves equities unrouted when only CoinMarketCap has a key', () => {
    const routes = priceRoutes({ coinMarketCap: 'cmc' }, priceProviders);

    expect(routes.get('crypto')).toBe(coinMarketCap);
    // Rather than calling an upstream we have no credentials for.
    expect(routes.get('stock')).toBeUndefined();
    expect(routes.get('fund')).toBeUndefined();
  });

  it('keeps crypto on Twelve Data when CoinMarketCap has no key', () => {
    const routes = priceRoutes({ twelveData: 'td' }, priceProviders);
    expect(routes.get('crypto')).toBe(twelveData);
  });

  it('sends gold and FX to the commodity feed, not the instrument providers', () => {
    const routes = priceRoutes(
      { twelveData: 'td', coinMarketCap: 'cmc' },
      priceProviders,
    );

    // Leaving these unrouted dropped them from `getMarketPrices()`, so every
    // gold/FX holding was valued at its purchase price forever.
    expect(routes.get('gold')).toBe(commodity);
    expect(routes.get('foreign_currency')).toBe(commodity);
  });

  it('ignores an empty-string key', () => {
    const routes = priceRoutes(
      { twelveData: '', coinMarketCap: '' },
      priceProviders,
    );

    expect(routes.get('stock')).toBeUndefined();
    expect(routes.get('crypto')).toBeUndefined();
    // Gold/FX are keyless, so they survive.
    expect(routes.size).toBe(2);
  });
});

describe('symbolReferenceRoutes', () => {
  it('always lists VN stocks — vnstock needs no key', () => {
    const routes = symbolReferenceRoutes({}, refProviders);
    expect(routes.get('stock')).toEqual([refVnstock]);
    // No crypto provider has a key, so that class stays unrouted.
    expect(routes.get('crypto')).toBeUndefined();
  });

  it('puts VN listings ahead of foreign ones in the stock picker', () => {
    const routes = symbolReferenceRoutes(
      { twelveData: 'td', coinMarketCap: 'cmc' },
      refProviders,
    );

    expect(routes.get('stock')).toEqual([refVnstock, refTwelveData]);
    expect(routes.get('crypto')).toEqual([refCoinMarketCap]);
  });

  it('falls back to Twelve Data for crypto when CoinMarketCap has no key', () => {
    const routes = symbolReferenceRoutes({ twelveData: 'td' }, refProviders);
    expect(routes.get('crypto')).toEqual([refTwelveData]);
  });

  it('lists only VN stocks when only CoinMarketCap has a key', () => {
    const routes = symbolReferenceRoutes(
      { coinMarketCap: 'cmc' },
      refProviders,
    );

    expect(routes.get('crypto')).toEqual([refCoinMarketCap]);
    expect(routes.get('stock')).toEqual([refVnstock]);
  });
});

describe('isVietnameseEquity', () => {
  const base = { assetClass: 'stock' as const, symbol: 'FPT' };

  it.each(['HOSE', 'HSX', 'HNX', 'UPCOM', 'hose'])(
    'treats %s as a Vietnamese venue',
    (market) => {
      expect(
        isVietnameseEquity({ ...base, market, quoteCurrency: 'VND' }),
      ).toBe(true);
    },
  );

  it('treats a foreign venue as not Vietnamese', () => {
    expect(
      isVietnameseEquity({ ...base, market: 'NASDAQ', quoteCurrency: 'USD' }),
    ).toBe(false);
  });

  it('trusts the venue over the currency when both are present', () => {
    // A VN-listed position mistakenly denominated in USD is still VN-listed.
    expect(
      isVietnameseEquity({ ...base, market: 'HOSE', quoteCurrency: 'USD' }),
    ).toBe(true);
    // And a NASDAQ position priced in VND is still foreign.
    expect(
      isVietnameseEquity({ ...base, market: 'NASDAQ', quoteCurrency: 'VND' }),
    ).toBe(false);
  });

  it('falls back to the currency when no venue is recorded', () => {
    expect(isVietnameseEquity({ ...base, quoteCurrency: 'VND' })).toBe(true);
    expect(isVietnameseEquity({ ...base, quoteCurrency: 'USD' })).toBe(false);
  });

  it('never guesses from the symbol alone', () => {
    // `FPT` looks Vietnamese but with no venue and a USD quote it must not be
    // routed to vnstock — a 3-letter code is a plausible foreign ticker too.
    expect(isVietnameseEquity({ ...base, quoteCurrency: 'USD' })).toBe(false);
  });
});

describe('priceOverrides', () => {
  const vnstock = { id: 'vnstock' } as unknown as PriceProvider;

  it('claims VN equities and funds, leaving foreign ones to the class route', () => {
    const [override] = priceOverrides({ vnstock });

    expect(
      override.matches({
        assetClass: 'stock',
        symbol: 'FPT',
        market: 'HOSE',
        quoteCurrency: 'VND',
      }),
    ).toBe(true);
    expect(
      override.matches({
        assetClass: 'fund',
        symbol: 'E1VFVN30',
        market: 'HOSE',
        quoteCurrency: 'VND',
      }),
    ).toBe(true);
    expect(
      override.matches({
        assetClass: 'stock',
        symbol: 'AAPL',
        market: 'NASDAQ',
        quoteCurrency: 'USD',
      }),
    ).toBe(false);
  });

  it('never claims crypto, even when priced in VND', () => {
    const [override] = priceOverrides({ vnstock });
    expect(
      override.matches({
        assetClass: 'crypto',
        symbol: 'BTC',
        quoteCurrency: 'VND',
      }),
    ).toBe(false);
  });
});

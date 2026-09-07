import { generateOrderCode, PAYMENT_DESCRIPTION } from './order-code';

describe('PayOS order code', () => {
  it('is a positive safe integer — PayOS rejects a string ref', () => {
    const code = generateOrderCode();

    expect(Number.isSafeInteger(code)).toBe(true);
    expect(code).toBeGreaterThan(0);
  });

  it('stays inside the accepted range', () => {
    // seconds % 100_000_000, times 100, plus at most 99.
    expect(generateOrderCode(new Date(8_640_000_000_000))).toBeLessThan(
      10_000_000_000,
    );
  });

  it('increases with time, so an order is findable by eye in the dashboard', () => {
    const earlier = generateOrderCode(new Date('2026-09-07T00:00:00Z'));
    const later = generateOrderCode(new Date('2026-09-08T00:00:00Z'));

    // Compared on the seconds half only: the random tail can go either way
    // within one second, which is the whole point of it.
    expect(Math.floor(later / 100)).toBeGreaterThan(Math.floor(earlier / 100));
  });

  it('varies within the same second', () => {
    // 100 slots a second. Collisions are possible and are settled by the
    // unique index; what matters is that they are not CERTAIN, which they
    // would be without the salt.
    const now = new Date('2026-09-07T12:00:00Z');
    const codes = new Set(
      Array.from({ length: 200 }, () => generateOrderCode(now)),
    );

    expect(codes.size).toBeGreaterThan(1);
  });

  it('keeps the description within PayOS\'s 9-character cap', () => {
    // Longer than 9 is rejected for bank accounts not linked to PayOS.
    expect(PAYMENT_DESCRIPTION.length).toBeLessThanOrEqual(9);
  });
});

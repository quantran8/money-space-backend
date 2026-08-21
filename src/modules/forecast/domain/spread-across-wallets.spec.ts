import { spreadAcrossWallets } from './spread-across-wallets';
import type { GoalPriority } from '../../goals/domain/goal-progress';

const M = 1_000_000;

/** Shorthand for a wallet's goal claim. */
function claim(
  amount: number,
  topPriority: GoalPriority | null = amount > 0 ? 'medium' : null,
) {
  return { amount, topPriority };
}

describe('spreadAcrossWallets', () => {
  /**
   * The order the household described: genuinely free money first, wherever it
   * sits, then by their own goal ranking — low before medium before high.
   */
  it('spends unpromised money in EVERY wallet before touching a goal', () => {
    const values = new Map([
      ['a', 10 * M],
      ['b', 10 * M],
    ]);
    // `a` is fully promised; `b` has 3tr free.
    const claims = new Map([
      ['a', claim(10 * M)],
      ['b', claim(7 * M)],
    ]);

    const { values: after, uncovered } = spreadAcrossWallets(
      values,
      claims,
      3 * M,
    );

    expect(uncovered).toBe(0);
    expect(after.get('a')).toBe(10 * M);
    expect(after.get('b')).toBe(7 * M);
  });

  it('pools the free money across wallets before any goal gives way', () => {
    const values = new Map([
      ['a', 10 * M],
      ['b', 10 * M],
    ]);
    // 2tr free in a, 3tr free in b → 5tr of genuinely free money.
    const claims = new Map([
      ['a', claim(8 * M)],
      ['b', claim(7 * M)],
    ]);

    const { values: after } = spreadAcrossWallets(values, claims, 5 * M);

    expect(after.get('a')).toBe(8 * M);
    expect(after.get('b')).toBe(7 * M);
  });

  /**
   * The household ranked their goals; a simulation that spent the important one
   * first would answer a question they did not ask.
   */
  it('takes from the LEAST important goal first', () => {
    const values = new Map([
      ['emergency', 10 * M],
      ['holiday', 10 * M],
    ]);
    const claims = new Map([
      ['emergency', claim(10 * M, 'high')],
      ['holiday', claim(10 * M, 'low')],
    ]);

    const { values: after } = spreadAcrossWallets(values, claims, 6 * M);

    // The `low` wallet pays all of it; the `high` one is untouched.
    expect(after.get('emergency')).toBe(10 * M);
    expect(after.get('holiday')).toBe(4 * M);
  });

  /**
   * Priority beats amount: 1tr promised to a `high` goal is not more expendable
   * than 50tr towards a `low` one just because it is a smaller number.
   */
  it('ranks priority above the amount promised', () => {
    const values = new Map([
      ['small-high', 10 * M],
      ['big-low', 10 * M],
    ]);
    const claims = new Map([
      ['small-high', claim(1 * M, 'high')],
      ['big-low', claim(10 * M, 'low')],
    ]);

    // 9tr free in `small-high` goes first (pass 1). The remaining 3tr must then
    // come from `big-low`'s goal money, not from the high-priority wallet.
    const { values: after } = spreadAcrossWallets(values, claims, 12 * M);

    expect(after.get('small-high')).toBe(1 * M);
    expect(after.get('big-low')).toBe(7 * M);
  });

  it('breaks a priority tie on the amount promised', () => {
    const values = new Map([
      ['heavy', 10 * M],
      ['light', 10 * M],
    ]);
    const claims = new Map([
      ['heavy', claim(10 * M, 'medium')],
      ['light', claim(4 * M, 'medium')],
    ]);

    const { values: after } = spreadAcrossWallets(values, claims, 8 * M);

    expect(after.get('heavy')).toBe(10 * M);
    expect(after.get('light')).toBe(2 * M);
  });

  it('moves on to the next wallet once one is empty', () => {
    const values = new Map([
      ['a', 5 * M],
      ['b', 5 * M],
    ]);
    const claims = new Map([
      ['a', claim(0, null)],
      ['b', claim(5 * M, 'high')],
    ]);

    const { values: after, uncovered } = spreadAcrossWallets(
      values,
      claims,
      8 * M,
    );

    expect(uncovered).toBe(0);
    expect(after.get('a')).toBe(0);
    expect(after.get('b')).toBe(2 * M);
  });

  it('reports what no wallet could cover', () => {
    const values = new Map([['a', 5 * M]]);
    const { values: after, uncovered } = spreadAcrossWallets(
      values,
      new Map([['a', claim(0, null)]]),
      8 * M,
    );

    expect(after.get('a')).toBe(0);
    expect(uncovered).toBe(3 * M);
  });

  it('never lets a wallet go negative', () => {
    const values = new Map([['a', 5 * M]]);
    const { values: after } = spreadAcrossWallets(
      values,
      new Map([['a', claim(5 * M, 'high')]]),
      50 * M,
    );
    expect(after.get('a')).toBe(0);
  });

  it('gives the same answer for the same question', () => {
    const values = new Map([
      ['a', 10 * M],
      ['b', 10 * M],
    ]);
    // Identical claims AND priorities: the tie must not resolve differently
    // between runs.
    const claims = new Map([
      ['a', claim(5 * M, 'medium')],
      ['b', claim(5 * M, 'medium')],
    ]);

    const first = spreadAcrossWallets(values, claims, 12 * M).values;
    const second = spreadAcrossWallets(values, claims, 12 * M).values;

    expect([...first]).toEqual([...second]);
  });
});

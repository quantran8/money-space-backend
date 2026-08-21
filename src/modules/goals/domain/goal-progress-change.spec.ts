import { buildGoalProgressChange } from './goal-progress-change';

const M = 1_000_000;

const line = (assetId: string, assetName: string, value: number) => ({
  assetId,
  assetName,
  value,
});

describe('buildGoalProgressChange', () => {
  /**
   * The household's own complaint: a goal at 50% yesterday reads 48% today and
   * nothing on screen says why. The figure is right — the gold really is worth
   * less — so the fix is the sentence, not the number.
   */
  it('names the asset behind a fall', () => {
    const change = buildGoalProgressChange(
      '2026-08-18',
      250 * M,
      240 * M,
      [line('gold', 'Vàng SJC', 120 * M), line('vcb', 'VCB', 130 * M)],
      [line('gold', 'Vàng SJC', 110 * M), line('vcb', 'VCB', 130 * M)],
    );
    expect(change).toMatchObject({
      previousDate: '2026-08-18',
      previousAmount: 250 * M,
      currentAmount: 240 * M,
      delta: -10 * M,
    });
    // Only the mover is named — an unchanged wallet explains nothing.
    expect(change?.reasons).toEqual([
      { assetId: 'gold', assetName: 'Vàng SJC', delta: -10 * M },
    ]);
  });

  it('orders reasons by how much they moved, biggest first', () => {
    const change = buildGoalProgressChange(
      '2026-08-18',
      300 * M,
      295 * M,
      [
        line('gold', 'Vàng', 100 * M),
        line('vnm', 'VNM', 100 * M),
        line('btc', 'BTC', 100 * M),
      ],
      [
        line('gold', 'Vàng', 98 * M),
        line('vnm', 'VNM', 112 * M),
        line('btc', 'BTC', 85 * M),
      ],
    );
    expect(change?.reasons.map((reason) => reason.assetId)).toEqual([
      'btc',
      'vnm',
    ]);
  });

  it('caps how many movers it names', () => {
    const change = buildGoalProgressChange(
      '2026-08-18',
      300 * M,
      270 * M,
      [
        line('a', 'A', 100 * M),
        line('b', 'B', 100 * M),
        line('c', 'C', 100 * M),
      ],
      [line('a', 'A', 90 * M), line('b', 'B', 90 * M), line('c', 'C', 90 * M)],
      1,
    );
    expect(change?.reasons).toHaveLength(1);
  });

  /** An asset newly assigned to the goal is a real reason the figure moved. */
  it('counts an asset that joined the goal', () => {
    const change = buildGoalProgressChange(
      '2026-08-18',
      100 * M,
      180 * M,
      [line('vcb', 'VCB', 100 * M)],
      [line('vcb', 'VCB', 100 * M), line('gold', 'Vàng', 80 * M)],
    );
    expect(change?.reasons).toEqual([
      { assetId: 'gold', assetName: 'Vàng', delta: 80 * M },
    ]);
  });

  /**
   * An asset unassigned, sold or deleted took its value with it. Without this
   * the largest drops of all would go unexplained.
   */
  it('counts an asset that left the goal', () => {
    const change = buildGoalProgressChange(
      '2026-08-18',
      180 * M,
      100 * M,
      [line('vcb', 'VCB', 100 * M), line('gold', 'Vàng', 80 * M)],
      [line('vcb', 'VCB', 100 * M)],
    );
    expect(change?.reasons).toEqual([
      { assetId: 'gold', assetName: 'Vàng', delta: -80 * M },
    ]);
  });

  // A line reading "no change" is noise on a screen that should stay quiet
  // unless it has something to report.
  it('says nothing when nothing moved', () => {
    expect(
      buildGoalProgressChange(
        '2026-08-18',
        240 * M,
        240 * M,
        [line('gold', 'Vàng', 240 * M)],
        [line('gold', 'Vàng', 240 * M)],
      ),
    ).toBeNull();
  });

  it("says nothing on a goal's first day", () => {
    expect(
      buildGoalProgressChange(
        null,
        null,
        240 * M,
        [],
        [line('gold', 'Vàng', 240 * M)],
      ),
    ).toBeNull();
  });

  /**
   * The total can move while the named assets net out — a fixed claim being
   * capped, for instance. The delta is still reported; the reasons just do not
   * add up to it, which is why the UI leads with the delta.
   */
  it('reports the delta even when no single asset explains all of it', () => {
    const change = buildGoalProgressChange(
      '2026-08-18',
      100 * M,
      90 * M,
      [line('vnm', 'VNM', 50 * M), line('gold', 'Vàng', 50 * M)],
      [line('vnm', 'VNM', 55 * M), line('gold', 'Vàng', 35 * M)],
    );
    expect(change?.delta).toBe(-10 * M);
    expect(change?.reasons).toHaveLength(2);
  });
});

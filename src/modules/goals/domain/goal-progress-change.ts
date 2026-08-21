/**
 * "Why did the number move?"
 *
 * A goal backed by gold reprices on its own. A household that saw 50% yesterday
 * and 48% today has done nothing wrong and changed nothing — but with no
 * explanation on screen, the figure looks arbitrary, and a number nobody can
 * explain is a number nobody trusts.
 *
 * The tempting fix — freeze the asset at what it was worth when it was assigned
 * — is worse than the problem. A goal showing 250tr of gold that would fetch
 * 240tr today does not confuse the household; it MISLEADS them. It is also the
 * same mistake `earmark` was: a stored figure floating free of the asset it
 * claims to describe.
 *
 * So the figure keeps following the assets, and this module supplies what was
 * missing: which asset moved, and by how much.
 *
 * Pure: the caller supplies both frozen points. Nothing here reads the clock or
 * the database.
 */

export interface GoalChangeAssetLine {
  assetId: string;
  assetName: string;
  value: number;
}

export interface GoalProgressChangeReason {
  assetId: string;
  assetName: string;
  /** Signed: negative when the asset lost value. */
  delta: number;
}

export interface GoalProgressChange {
  /** `YYYY-MM-DD` of the point being compared against. */
  previousDate: string;
  previousAmount: number;
  currentAmount: number;
  /** Signed change in the goal's progress since `previousDate`. */
  delta: number;
  /**
   * The assets behind the change, biggest mover first. Only assets that
   * actually moved appear; an unchanged holding explains nothing.
   */
  reasons: GoalProgressChangeReason[];
}

/**
 * What changed since the last frozen point, or `null` when there is nothing
 * worth saying.
 *
 * Returns null when there is no earlier point (a goal's first day has no
 * "before"), and when nothing moved — a line reading "no change" is noise on a
 * screen that should be quiet unless it has something to report.
 *
 * @param previousDate   `YYYY-MM-DD` of the earlier point.
 * @param previousAmount The goal's progress at that point.
 * @param currentAmount  The goal's progress now.
 * @param previousAssets Per-asset values frozen at that point.
 * @param currentAssets  Per-asset values now.
 * @param maxReasons     How many movers to name individually.
 */
export function buildGoalProgressChange(
  previousDate: string | null,
  previousAmount: number | null,
  currentAmount: number,
  previousAssets: GoalChangeAssetLine[],
  currentAssets: GoalChangeAssetLine[],
  maxReasons = 2,
): GoalProgressChange | null {
  if (previousDate === null || previousAmount === null) {
    return null;
  }
  const delta = currentAmount - previousAmount;
  if (delta === 0) {
    return null;
  }

  const previousByAsset = new Map(
    previousAssets.map((line) => [line.assetId, line]),
  );
  const seen = new Set<string>();
  const reasons: GoalProgressChangeReason[] = [];

  for (const line of currentAssets) {
    seen.add(line.assetId);
    const before = previousByAsset.get(line.assetId);
    // An asset the goal did not hold before contributes its whole value: it is
    // new to the goal, which is a real reason the figure moved.
    const assetDelta = line.value - (before?.value ?? 0);
    if (assetDelta !== 0) {
      reasons.push({
        assetId: line.assetId,
        assetName: line.assetName,
        delta: assetDelta,
      });
    }
  }
  // An asset that has left the goal (unassigned, sold, deleted) took its value
  // with it and must still be named — otherwise the largest drops go unexplained.
  for (const line of previousAssets) {
    if (!seen.has(line.assetId) && line.value !== 0) {
      reasons.push({
        assetId: line.assetId,
        assetName: line.assetName,
        delta: -line.value,
      });
    }
  }

  reasons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return {
    previousDate,
    previousAmount,
    currentAmount,
    delta,
    reasons: reasons.slice(0, Math.max(0, maxReasons)),
  };
}

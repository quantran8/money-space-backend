/**
 * "Did we keep the pace this month?"
 *
 * A goal's progress figure answers *how much is behind this goal now*. It does
 * not answer the question a household actually asks month to month:
 *
 *   > we meant to set aside 10tr a month; in January we managed exactly 10tr,
 *   > in February we spent 2tr of it, so only 8tr went in.
 *
 * That is a DIFFERENCE between two points in time, and it is why goal progress
 * is frozen into every snapshot (`snapshot_goal_values`). Each month's figure is
 * the goal's progress at the last snapshot of that month minus the same at the
 * last snapshot of the previous month.
 *
 * The delta therefore already accounts for everything that moved the goal:
 * money added to an asset, money spent out of one, and the asset repricing.
 * There is nothing separate to record and nothing that can disagree with it.
 *
 * Pure: the caller supplies the frozen points and the declared pace. Nothing
 * here reads the clock or the database.
 */

export interface GoalProgressPoint {
  /** `YYYY-MM-DD` — the snapshot's own date. */
  date: string;
  progressAmount: number;
  /**
   * The `contribution`-role part of `progressAmount` — money the household put
   * in, with market movement excluded. `null` for points frozen before the
   * column existed, which is NOT the same as 0: see `delta`.
   */
  contributionAmount: number | null;
}

export interface GoalMonthProgress {
  /** `YYYY-MM`. */
  month: string;
  /** Total progress at the last snapshot of this month, market value included. */
  endAmount: number;
  /**
   * The part of `endAmount` the household is holding rather than contributing
   * through — gold, stocks, crypto. Shown separately so the pace and the
   * holdings are never read as one figure.
   */
  holdingsAmount: number;
  /**
   * How much the household PUT IN during the month — contribution shares only,
   * so gold repricing never lands here. NEGATIVE when more was spent out of
   * those wallets than came in: that is the signal, not an error, so it is never
   * clamped.
   *
   * `null` in three cases, each meaning "we cannot say", never "nothing":
   *  - the FIRST month with data when the goal carries no creation baseline —
   *    there is no previous month to subtract, and a household arriving with
   *    200M already saved did not save 200M that month. A goal created through
   *    the current form DOES carry one (`baselineContribution`), so its first
   *    month reports a real figure measured from the declared opening balance;
   *  - a month frozen before contributions were tracked separately;
   *  - the running month when the month before it has no close (see below).
   */
  delta: number | null;
  /**
   * The declared pace, or null when the household never set one — or when the
   * goal has no contribution source at all, since a goal backed only by gold
   * was never meant to be fed monthly and reporting it as behind every month
   * would be a verdict on a plan nobody made.
   */
  planned: number | null;
  /**
   * `delta - planned`. Negative means the month fell short. Null whenever either
   * side is null — with no declared pace there is nothing to fall short of.
   */
  gap: number | null;
  /**
   * True for the month still running. Its `delta` is measured to RIGHT NOW
   * rather than to a month-end close, so it is a partial figure that will keep
   * moving — the UI has to say so rather than showing it as a shortfall.
   *
   * Without this row a household mid-month sees a 10tr target and nothing else,
   * and has to wait until the month closes to learn where it stands. That gap
   * was hidden while goals had a "contribute" button (you saw what you put in);
   * removing the button removed the feedback with it.
   */
  inProgress: boolean;
}

/** `YYYY-MM-DD` → `YYYY-MM`. */
function monthOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * One row per month that has at least one snapshot, oldest first.
 *
 * Months with no snapshot at all are skipped rather than filled with zeros: no
 * snapshot means nobody looked, which is not the same as "nothing was saved".
 * Inventing a 0 row would report a household as having missed a month it may
 * well have kept.
 *
 * The month still running gets a row too, measured to `current` instead of to a
 * close, so a household does not have to wait for the month to end to see where
 * it stands. It is marked `inProgress` because it is a partial figure.
 *
 * @param points  Frozen progress points, in any order.
 * @param plannedMonthlyContribution  The declared pace; null/<= 0 means none.
 * @param options.current  Progress right now, dated today. Omit for history only.
 * @param options.hasContributionSource
 *   Whether the goal has any `contribution` allocation at all. A goal backed
 *   only by gold has no pace to keep, so it reports no target rather than a
 *   shortfall every month.
 * @param options.conversionCreditByMonth
 *   Per month (`YYYY-MM`), money that left a contribution wallet only to become
 *   a holding INSIDE THE SAME GOAL. Added back, because swapping cash for gold
 *   is a change of form, not a withdrawal — see `buildConversionCredit`.
 * @param options.monthlyHeadroom
 *   What the wallets could still put in this month given what they hold —
 *   `min(walletValue - setAside, pace)` summed per wallet. Used for the RUNNING
 *   month only, and only when it has no real previous close to be measured
 *   against: the month is not over, so what the panel can honestly offer is what
 *   the household is on track to manage, not a verdict. Closed months always use
 *   the observed difference and ignore this entirely.
 * @param options.baselineContribution
 *   What the goal OPENED with, frozen at creation. Stands in as the previous
 *   point for the FIRST month on record, which otherwise has nothing to be
 *   measured against and reports null. The household declared this figure as an
 *   opening balance on the create form, so treating it as the starting line is
 *   reading back what they said — not a guess. Null for goals created before it
 *   was recorded, which keeps their first month blank as before.
 */
export function buildGoalMonthlyProgress(
  points: GoalProgressPoint[],
  plannedMonthlyContribution: number | null,
  options?: {
    current?: GoalProgressPoint;
    hasContributionSource?: boolean;
    conversionCreditByMonth?: ReadonlyMap<string, number>;
    baselineContribution?: number | null;
    monthlyHeadroom?: number | null;
  },
): GoalMonthProgress[] {
  const current = options?.current;
  // The LAST snapshot of each month is the month's closing figure. Sorting
  // ascending and overwriting leaves exactly that in the map. The live point is
  // just one more point, dated today — being the latest, it wins its own month,
  // which is precisely the "so far this month" figure.
  const merged = current ? [...points, current] : points;
  const lastOfMonth = new Map<string, GoalProgressPoint>();
  for (const point of [...merged].sort((a, b) =>
    a.date.localeCompare(b.date),
  )) {
    lastOfMonth.set(monthOf(point.date), point);
  }

  // No contribution source means no pace was ever planned for, whatever number
  // sits in the goal's `planned_monthly_contribution`.
  const planned =
    options?.hasContributionSource !== false &&
    plannedMonthlyContribution !== null &&
    plannedMonthlyContribution > 0
      ? plannedMonthlyContribution
      : null;

  const liveMonth = current ? monthOf(current.date) : null;
  const months = [...lastOfMonth.keys()].sort();
  return months.map((month, index) => {
    const point = lastOfMonth.get(month);
    const endAmount = point?.progressAmount ?? 0;
    const contribution = point?.contributionAmount ?? null;
    // Compare against the previous month PRESENT in the data, not the calendar
    // month before: a gap in snapshots would otherwise report the whole catch-up
    // as one month's saving.
    const previousPoint =
      index > 0 ? lastOfMonth.get(months[index - 1]) : undefined;
    const inProgress = month === liveMonth;
    // The running month needs the month DIRECTLY before it. When snapshots skip
    // a month, the previous entry is older than that, and the difference would
    // silently bundle several months of saving into "this month". Better to
    // report no figure than a flattering one.
    const previousIsAdjacent =
      index > 0 ? isMonthBefore(months[index - 1], month) : false;

    // Both ends must know their contribution figure. A point frozen before the
    // column existed reports `null`, and treating it as 0 would show the next
    // month as a huge jump the household never made.
    //
    // The FIRST month has no previous point at all. Its left-hand side is the
    // baseline the household declared when creating the goal — "this much is
    // already set aside" — which is exactly the opening balance a previous
    // point would have carried. With it, a goal created this month reports 0
    // until money actually moves in, instead of a blank that reads as "we
    // cannot say" about a figure the household did in fact state.
    const previousContribution =
      index === 0
        ? (options?.baselineContribution ?? null)
        : (previousPoint?.contributionAmount ?? null);
    // The adjacency guard protects against bundling several skipped months into
    // one figure. It cannot apply to the first month: its left-hand side is the
    // creation baseline, not an older close, so there are no skipped months
    // hiding in the difference.
    const observedDelta =
      contribution === null ||
      previousContribution === null ||
      (inProgress && !previousIsAdjacent && index > 0)
        ? null
        : contribution -
          previousContribution +
          (options?.conversionCreditByMonth?.get(month) ?? 0);

    // The running month is not a verdict — it is not over. When there is no real
    // close behind it, the observed difference is 0 for a goal just created and
    // says nothing useful, so the estimate takes over: what the wallets can
    // still put in, capped by the pace they declared. A CLOSED month never uses
    // it; by then the difference between two closes is the truth.
    const delta =
      inProgress && index === 0 && options?.monthlyHeadroom !== undefined
        ? options.monthlyHeadroom
        : observedDelta;

    return {
      month,
      endAmount,
      // Whatever is not contribution money is value being held. Floored at 0:
      // a legacy point with no contribution figure reports all of it as held,
      // which is the honest reading of "we do not know how it got there".
      holdingsAmount: Math.max(0, endAmount - (contribution ?? 0)),
      delta,
      planned,
      gap: delta === null || planned === null ? null : delta - planned,
      inProgress,
    };
  });
}

export interface GoalConversionPurchase {
  /** `YYYY-MM-DD` — the purchase date. */
  date: string;
  amount: number;
}

/**
 * Money that left a contribution wallet only to reappear as a holding in the
 * SAME goal, summed per month.
 *
 * Buying 10tr of gold out of a wallet that feeds this goal drops the wallet by
 * 10tr, so the pace would read −10tr — as if the household had spent the money.
 * It did not: it changed the form it holds, and the goal's total progress does
 * not move at all. Adding the purchase back leaves the pace flat, which is the
 * truthful answer.
 *
 * The caller passes ONLY purchases where both ends belong to this goal. A
 * purchase paid from a goal wallet into an asset outside the goal is a real
 * withdrawal and must keep showing as one.
 *
 * This became possible only once `asset_purchase` started carrying
 * `from_asset_id`: before that, a wallet drop and a gold rise were two unrelated
 * facts, and pairing them would have been a guess.
 */
export function buildConversionCredit(
  purchases: GoalConversionPurchase[],
): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const purchase of purchases) {
    const month = monthOf(purchase.date);
    byMonth.set(month, (byMonth.get(month) ?? 0) + purchase.amount);
  }
  return byMonth;
}

/** Whether `earlier` is the calendar month immediately before `later`. */
function isMonthBefore(earlier: string, later: string): boolean {
  const [ey, em] = earlier.split('-').map(Number);
  const [ly, lm] = later.split('-').map(Number);
  return ey * 12 + em + 1 === ly * 12 + lm;
}

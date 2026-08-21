import {
  buildConversionCredit,
  buildGoalMonthlyProgress,
} from './goal-monthly-progress';

const M = 1_000_000;

/**
 * A point on a goal fed entirely through a wallet, where every đồng of progress
 * IS contributed money. Most pace tests want that: they are about the arithmetic
 * of the pace, not about telling contributions apart from holdings.
 */
function point(date: string, amount: number) {
  return { date, progressAmount: amount, contributionAmount: amount };
}

describe('buildGoalMonthlyProgress', () => {
  // The household's own example: a declared pace of 10tr a month. January lands
  // exactly on it; in February 2tr is spent back out of the backing asset, so
  // only 8tr of the month's saving survives.
  it('reports the month that fell short by what was spent', () => {
    const rows = buildGoalMonthlyProgress(
      [
        point('2025-12-31', 0),
        point('2026-01-31', 10 * M),
        point('2026-02-28', 18 * M),
      ],
      10 * M,
    );

    expect(rows.map((row) => row.month)).toEqual([
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(rows[1]).toMatchObject({ delta: 10 * M, planned: 10 * M, gap: 0 });
    expect(rows[2]).toMatchObject({
      delta: 8 * M,
      planned: 10 * M,
      gap: -2 * M,
    });
  });

  // A household that arrives with savings already behind the goal did not save
  // all of it in that first month, so there is no honest delta to report.
  it('leaves the first month with no delta rather than inventing one', () => {
    const rows = buildGoalMonthlyProgress(
      [point('2026-01-31', 200 * M)],
      10 * M,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endAmount: 200 * M,
      delta: null,
      gap: null,
    });
  });

  // Spending more than went in is the signal the panel exists to show, so it is
  // reported as a negative month, never clamped to 0.
  it('reports a negative month when more went out than in', () => {
    const rows = buildGoalMonthlyProgress(
      [point('2026-01-31', 50 * M), point('2026-02-28', 30 * M)],
      10 * M,
    );
    expect(rows[1]).toMatchObject({ delta: -20 * M, gap: -30 * M });
  });

  it('uses the LAST snapshot of a month as its closing figure', () => {
    const rows = buildGoalMonthlyProgress(
      [
        point('2026-01-05', 3 * M),
        point('2026-01-20', 7 * M),
        point('2026-01-31', 10 * M),
      ],
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].endAmount).toBe(10 * M);
  });

  it('sorts unordered points before reading them', () => {
    const rows = buildGoalMonthlyProgress(
      [point('2026-02-28', 18 * M), point('2026-01-31', 10 * M)],
      null,
    );
    expect(rows.map((row) => row.month)).toEqual(['2026-01', '2026-02']);
    expect(rows[1].delta).toBe(8 * M);
  });

  // A month nobody snapshotted is a month nobody looked at — reporting a 0 row
  // would accuse the household of missing a month they may well have kept.
  it('skips months with no snapshot instead of filling them with zero', () => {
    const rows = buildGoalMonthlyProgress(
      [point('2026-01-31', 10 * M), point('2026-04-30', 40 * M)],
      10 * M,
    );
    expect(rows.map((row) => row.month)).toEqual(['2026-01', '2026-04']);
    // The delta spans the whole gap, measured against the previous month that
    // actually has data.
    expect(rows[1].delta).toBe(30 * M);
  });

  it('reports no pace to compare against when none was declared', () => {
    const rows = buildGoalMonthlyProgress(
      [point('2026-01-31', 10 * M), point('2026-02-28', 18 * M)],
      null,
    );
    expect(rows[1]).toMatchObject({ delta: 8 * M, planned: null, gap: null });
  });

  it('treats a zero or negative declared pace as none', () => {
    const rows = buildGoalMonthlyProgress(
      [point('2026-01-31', 10 * M), point('2026-02-28', 18 * M)],
      0,
    );
    expect(rows[1].planned).toBeNull();
  });

  it('is empty when the goal has no frozen points yet', () => {
    expect(buildGoalMonthlyProgress([], 10 * M)).toEqual([]);
  });

  /**
   * Mid-month a household should not have to wait for the month to close to see
   * where it stands — the feedback the removed "contribute" button used to give.
   */
  describe('the month still running', () => {
    it('measures the current month against the previous close', () => {
      const rows = buildGoalMonthlyProgress(
        [point('2026-07-31', 20 * M), point('2026-08-05', 22 * M)],
        10 * M,
        { current: point('2026-08-19', 26 * M) },
      );
      const live = rows.at(-1);
      // 26tr now against 20tr at the end of July: 6tr in so far, 4tr to go.
      expect(live).toMatchObject({
        month: '2026-08',
        delta: 6 * M,
        planned: 10 * M,
        gap: -4 * M,
        inProgress: true,
      });
      // Closed months are never marked live.
      expect(rows[0].inProgress).toBe(false);
    });

    it('supersedes an earlier snapshot in the same month', () => {
      const rows = buildGoalMonthlyProgress(
        [point('2026-07-31', 20 * M), point('2026-08-05', 22 * M)],
        null,
        { current: point('2026-08-19', 26 * M) },
      );
      // One row for August, holding the live figure — not the 5 Aug snapshot.
      expect(rows).toHaveLength(2);
      expect(rows[1].endAmount).toBe(26 * M);
    });

    it('opens a row for a month that has no snapshot of its own yet', () => {
      const rows = buildGoalMonthlyProgress(
        [point('2026-07-31', 20 * M)],
        10 * M,
        { current: point('2026-08-02', 23 * M) },
      );
      expect(rows.map((row) => row.month)).toEqual(['2026-07', '2026-08']);
      expect(rows[1].delta).toBe(3 * M);
    });

    it('reports a negative running month as it is', () => {
      const rows = buildGoalMonthlyProgress(
        [point('2026-07-31', 20 * M)],
        10 * M,
        { current: point('2026-08-19', 17 * M) },
      );
      expect(rows[1]).toMatchObject({ delta: -3 * M, gap: -13 * M });
    });

    it('still reports the running month without a declared pace', () => {
      const rows = buildGoalMonthlyProgress(
        [point('2026-07-31', 20 * M)],
        null,
        { current: point('2026-08-19', 26 * M) },
      );
      // Knowing the month is up 6tr is useful even with nothing to compare to.
      expect(rows[1]).toMatchObject({ delta: 6 * M, planned: null, gap: null });
    });

    it('withholds a delta when the previous month has no close', () => {
      const rows = buildGoalMonthlyProgress(
        [point('2026-05-31', 20 * M)],
        10 * M,
        { current: point('2026-08-19', 50 * M) },
      );
      // 30tr accumulated since May is not "saved this month". Reporting it as
      // such would flatter the household; a blank says what is actually known.
      expect(rows[1]).toMatchObject({
        month: '2026-08',
        delta: null,
        gap: null,
      });
    });

    it('withholds a delta for the very first month on record', () => {
      const rows = buildGoalMonthlyProgress([], 10 * M, {
        current: point('2026-08-19', 200 * M),
      });
      // A household arriving with 200tr already saved did not save it this month.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ delta: null, inProgress: true });
    });
  });

  /**
   * The opening balance the create form asked for, used as the first month's
   * left-hand side.
   *
   * Without it a goal created this month showed "—" against its declared pace,
   * which reads as "we cannot say" — but the household HAD said, on the very
   * form that created the goal: this much is already set aside, that much goes
   * in monthly. The two answers were being conflated into one number.
   */
  describe('with a creation baseline', () => {
    // The reported case: a wallet holding 22tr, 20tr of it declared as already
    // set aside for the goal, 20tr/month declared as the pace. Nothing has moved
    // in yet, so the month is 0 — NOT the 2tr left over in the wallet, which is
    // money that was never behind this goal at all.
    it('reports 0 for a goal created this month with nothing moved in yet', () => {
      const rows = buildGoalMonthlyProgress([], 20 * M, {
        current: point('2026-08-20', 20 * M),
        baselineContribution: 20 * M,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        month: '2026-08',
        delta: 0,
        planned: 20 * M,
        gap: -20 * M,
        inProgress: true,
      });
    });

    // Once money actually goes in, the month counts it — measured from the
    // declared opening balance, never from zero.
    it('counts only what moved in on top of the opening balance', () => {
      const rows = buildGoalMonthlyProgress([], 20 * M, {
        current: point('2026-08-20', 32 * M),
        baselineContribution: 20 * M,
      });
      expect(rows[0]).toMatchObject({ delta: 12 * M, gap: -8 * M });
    });

    // Spending out of the opening balance is a negative month, not a blank.
    it('reports a negative first month when the opening balance is drawn down', () => {
      const rows = buildGoalMonthlyProgress([], 20 * M, {
        current: point('2026-08-20', 15 * M),
        baselineContribution: 20 * M,
      });
      expect(rows[0]).toMatchObject({ delta: -5 * M });
    });

    // The baseline belongs to the FIRST month only. Later months are measured
    // against the month before them, exactly as before — a baseline reaching
    // past the first month would overwrite real history.
    it('uses the baseline only for the first month, never for later ones', () => {
      const rows = buildGoalMonthlyProgress(
        [point('2026-07-31', 30 * M), point('2026-08-31', 45 * M)],
        10 * M,
        { baselineContribution: 20 * M },
      );
      expect(rows[0]).toMatchObject({ month: '2026-07', delta: 10 * M });
      expect(rows[1]).toMatchObject({ month: '2026-08', delta: 15 * M });
    });

    // A goal predating the baseline column keeps the old behaviour: a blank
    // first month rather than a figure measured from an assumed zero.
    it('leaves the first month blank when no baseline was recorded', () => {
      const rows = buildGoalMonthlyProgress([], 20 * M, {
        current: point('2026-08-20', 20 * M),
        baselineContribution: null,
      });
      expect(rows[0]).toMatchObject({ delta: null, gap: null });
    });

    /**
     * The running month as an ESTIMATE, not a verdict.
     *
     * The household's own examples. A month that has not ended cannot be
     * reported as kept or missed, so what the panel shows is what the wallets
     * can still put in — capped by the pace those wallets declared.
     */
    describe('running month, estimated from what the wallets hold', () => {
      // Wallet 22tr, 20tr of it already set aside, pace 20tr → 2tr left to give.
      it("estimates the month from the wallet's free balance", () => {
        const rows = buildGoalMonthlyProgress([], 20 * M, {
          current: point('2026-08-20', 20 * M),
          baselineContribution: 20 * M,
          monthlyHeadroom: 2 * M,
        });
        expect(rows[0]).toMatchObject({
          month: '2026-08',
          delta: 2 * M,
          planned: 20 * M,
          gap: -18 * M,
          inProgress: true,
        });
      });

      // Wallet 30tr, seed 20tr, pace 20tr → 10tr.
      it('follows the free balance up as the wallet grows', () => {
        const rows = buildGoalMonthlyProgress([], 20 * M, {
          current: point('2026-08-20', 20 * M),
          baselineContribution: 20 * M,
          monthlyHeadroom: 10 * M,
        });
        expect(rows[0]).toMatchObject({ delta: 10 * M, gap: -10 * M });
      });

      // Wallet 100tr, seed 20tr → 80tr free, but the household declared 20tr a
      // month. It is not putting the whole balance into the car, so the estimate
      // stops at the pace and the month reads as met, never as a surplus.
      it('never estimates above the declared pace', () => {
        const rows = buildGoalMonthlyProgress([], 20 * M, {
          current: point('2026-08-20', 20 * M),
          baselineContribution: 20 * M,
          monthlyHeadroom: 20 * M,
        });
        expect(rows[0]).toMatchObject({ delta: 20 * M, gap: 0 });
      });

      // The flag the UI reads to pick its label. Calling a capacity estimate
      // "đã góp" claims money moved when none may have — the panel says
      // "có thể góp" instead, but only when it can tell the two apart.
      it('marks the headroom figure as an estimate', () => {
        const rows = buildGoalMonthlyProgress([], 20 * M, {
          current: point('2026-08-20', 20 * M),
          baselineContribution: 20 * M,
          monthlyHeadroom: 2 * M,
        });
        expect(rows[0]).toMatchObject({ delta: 2 * M, isEstimate: true });
      });

      // An observed difference between two closes is a record, not a forecast.
      it('does not mark an observed running month as an estimate', () => {
        const rows = buildGoalMonthlyProgress(
          [point('2026-07-31', 30 * M)],
          20 * M,
          {
            current: point('2026-08-20', 38 * M),
            baselineContribution: 20 * M,
            monthlyHeadroom: 20 * M,
          },
        );
        expect(rows[1]).toMatchObject({
          month: '2026-08',
          delta: 8 * M,
          inProgress: true,
          isEstimate: false,
        });
      });

      // A CLOSED month is settled by what actually happened. The estimate is for
      // a month still in play and must never rewrite a month that has ended.
      it('ignores the estimate once a month has closed', () => {
        const rows = buildGoalMonthlyProgress(
          [point('2026-07-31', 30 * M), point('2026-08-31', 38 * M)],
          20 * M,
          { baselineContribution: 20 * M, monthlyHeadroom: 20 * M },
        );
        expect(rows[1]).toMatchObject({ month: '2026-08', delta: 8 * M });
      });

      // With closed history behind it, the running month has a real previous
      // close to measure against, so the observed figure is the honest one.
      it('prefers the observed figure when a real previous close exists', () => {
        const rows = buildGoalMonthlyProgress(
          [point('2026-07-31', 30 * M)],
          20 * M,
          {
            current: point('2026-08-20', 36 * M),
            baselineContribution: 20 * M,
            monthlyHeadroom: 20 * M,
          },
        );
        expect(rows[1]).toMatchObject({ month: '2026-08', delta: 6 * M });
      });
    });

    // A goal backed only by gold has no pace to keep, so the baseline must not
    // conjure a verdict against a plan nobody made.
    it('still reports no pace when the goal has no contribution source', () => {
      const rows = buildGoalMonthlyProgress([], 20 * M, {
        current: point('2026-08-20', 25 * M),
        baselineContribution: 20 * M,
        hasContributionSource: false,
      });
      expect(rows[0]).toMatchObject({ planned: null, gap: null });
    });
  });

  /**
   * The reason the contribution figure is frozen separately at all: a pace built
   * on the total answered "did we keep our 10tr?" with the gold price.
   */
  describe('market movement stays out of the pace', () => {
    it('ignores a holding repricing', () => {
      const rows = buildGoalMonthlyProgress(
        [
          // 50tr wallet + 100tr gold.
          {
            date: '2026-07-31',
            progressAmount: 150 * M,
            contributionAmount: 50 * M,
          },
          // Gold rose 20tr; nobody put a đồng in.
          {
            date: '2026-08-31',
            progressAmount: 170 * M,
            contributionAmount: 50 * M,
          },
        ],
        10 * M,
      );
      // The old formula read +20tr and called it "đủ nhịp".
      expect(rows[1]).toMatchObject({ delta: 0, gap: -10 * M });
      expect(rows[1].holdingsAmount).toBe(120 * M);
    });

    it('still credits a month whose holdings fell', () => {
      const rows = buildGoalMonthlyProgress(
        [
          {
            date: '2026-07-31',
            progressAmount: 150 * M,
            contributionAmount: 50 * M,
          },
          // Gold lost 20tr, but the household saved its full 10tr.
          {
            date: '2026-08-31',
            progressAmount: 140 * M,
            contributionAmount: 60 * M,
          },
        ],
        10 * M,
      );
      // The old formula read −10tr and reported a household that kept its pace
      // as having fallen 20tr short.
      expect(rows[1]).toMatchObject({ delta: 10 * M, gap: 0 });
    });

    it('withholds a delta across points frozen before contributions were tracked', () => {
      const rows = buildGoalMonthlyProgress(
        [
          // Legacy row: a total, no contribution figure.
          {
            date: '2026-07-31',
            progressAmount: 150 * M,
            contributionAmount: null,
          },
          {
            date: '2026-08-31',
            progressAmount: 160 * M,
            contributionAmount: 60 * M,
          },
        ],
        10 * M,
      );
      // Treating the missing figure as 0 would report a 60tr month.
      expect(rows[1].delta).toBeNull();
      // Everything unattributed reads as held, which is the honest default.
      expect(rows[0].holdingsAmount).toBe(150 * M);
    });
  });

  /**
   * A goal backed only by gold was never meant to be fed monthly. Reporting it
   * as behind every month would be a verdict on a plan nobody made.
   */
  it('reports no pace for a goal with no contribution source', () => {
    const rows = buildGoalMonthlyProgress(
      [
        { date: '2026-07-31', progressAmount: 150 * M, contributionAmount: 0 },
        { date: '2026-08-31', progressAmount: 170 * M, contributionAmount: 0 },
      ],
      10 * M,
      { hasContributionSource: false },
    );
    expect(rows[1]).toMatchObject({ delta: 0, planned: null, gap: null });
  });

  /**
   * Swapping cash for gold inside one goal is a change of form, not a
   * withdrawal — the goal's total does not move at all.
   */
  describe('converting cash into a holding', () => {
    it('leaves the pace flat instead of reporting a withdrawal', () => {
      const rows = buildGoalMonthlyProgress(
        [
          {
            date: '2026-07-31',
            progressAmount: 150 * M,
            contributionAmount: 50 * M,
          },
          // Wallet down 10tr, gold up 10tr: total unchanged.
          {
            date: '2026-08-31',
            progressAmount: 150 * M,
            contributionAmount: 40 * M,
          },
        ],
        10 * M,
        {
          conversionCreditByMonth: buildConversionCredit([
            { date: '2026-08-14', amount: 10 * M },
          ]),
        },
      );
      // Without the credit this reads −10tr, as if the money had been spent.
      expect(rows[1].delta).toBe(0);
    });

    it('does not credit a purchase outside the goal', () => {
      const rows = buildGoalMonthlyProgress(
        [
          {
            date: '2026-07-31',
            progressAmount: 150 * M,
            contributionAmount: 50 * M,
          },
          {
            date: '2026-08-31',
            progressAmount: 140 * M,
            contributionAmount: 40 * M,
          },
        ],
        10 * M,
        // The caller passes no conversion: the gold bought is not in this goal,
        // so the money really did leave it.
        { conversionCreditByMonth: buildConversionCredit([]) },
      );
      expect(rows[1].delta).toBe(-10 * M);
    });

    it('sums several conversions in one month', () => {
      const credit = buildConversionCredit([
        { date: '2026-08-03', amount: 4 * M },
        { date: '2026-08-20', amount: 6 * M },
        { date: '2026-09-01', amount: 5 * M },
      ]);
      expect(credit.get('2026-08')).toBe(10 * M);
      expect(credit.get('2026-09')).toBe(5 * M);
    });
  });
});

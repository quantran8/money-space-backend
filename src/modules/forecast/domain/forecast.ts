/**
 * The forecast engine (spec §26A, 05 §2).
 *
 * Answers "what happens to our cash over the next N days, day by day" — and
 * from that, the number the whole product exists to surface: the **lowest
 * projected balance**. A household can end the month positive and still have a
 * real problem on the 15th; a single end-of-period total hides exactly that.
 *
 * Pure and dependency-free: no Nest, no Prisma, no clock. `asOfDate` is always
 * passed in, so every run is deterministic and testable.
 *
 * This engine NEVER writes. Virtual occurrences are objects, not rows (§2.15);
 * there is no `forecasts` table and there must not be one.
 */

import {
  addDaysIso,
  daysBetweenIso,
  type IsoDate,
} from '../../../common/utils/clock';
import { expandOccurrences } from '../../../common/utils/recurrence';
import type {
  CalculationAssumption,
  ForecastDay,
  ForecastInput,
  ForecastOccurrence,
  ForecastResult,
} from './forecast.types';

/** Assets older than this are flagged in the assumptions, not excluded. */
const DEFAULT_STALE_AFTER_DAYS = 30;

/** VND has no minor unit; round once at the end, never mid-running-balance. */
function round(value: number): number {
  return Math.round(value);
}

export function runForecast(input: ForecastInput): ForecastResult {
  const { householdId, asOfDate, horizonDays, assets, options = {} } = input;

  const includeEstimatedIncoming = options.includeEstimatedIncoming ?? false;
  const includePlannedOutgoing = options.includePlannedOutgoing ?? true;
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;

  // 1. Window — inclusive at both ends, so horizonDays=30 yields 31 day rows.
  const horizonEndDate = addDaysIso(asOfDate, horizonDays);

  // 2. Starting balance: only money that is spendable TODAY. Savings and
  //    long-term assets are net worth, not cash flow — counting them would
  //    make a household look liquid when its money is locked up.
  //
  //    Liquidity is the ONLY filter. Nothing is excluded for being private or
  //    personal any more: a shared figure that silently omits records is not a
  //    shared source of truth, and the old rule also put this number
  //    permanently at odds with the dashboard's net worth, which never applied
  //    it.
  const usableNow = assets.filter((asset) => asset.liquidity === 'usable_now');
  const startingLiquidBalance = usableNow.reduce(
    (sum, asset) => sum + asset.value,
    0,
  );

  // 3. Event eligibility.
  const allEvents = [
    ...input.cashflowEvents,
    ...(options.syntheticEvents ?? []),
  ];
  const eligible = allEvents.filter(
    (event) => event.status !== 'completed' && event.status !== 'cancelled',
  );

  // 4. Expand every event into concrete occurrences inside the window.
  const occurrences: ForecastOccurrence[] = [];
  let sawClampedFromPast = false;

  for (const event of eligible) {
    const expanded = expandOccurrences({
      expectedDate: event.expectedDate,
      recurrence: event.recurrence,
      recurrenceEndDate: event.recurrenceEndDate ?? null,
      asOfDate,
      horizonEndDate,
    });

    for (const occurrence of expanded) {
      // `postponed` is surfaced so the user sees it, but its date is no longer
      // trustworthy, so it must not move the balance.
      const postponed = event.status === 'postponed';
      const estimatedIncoming =
        event.direction === 'incoming' &&
        event.certainty === 'estimated' &&
        !includeEstimatedIncoming;
      const plannedOutgoing =
        event.direction === 'outgoing' &&
        event.requirement === 'planned' &&
        !includePlannedOutgoing;

      let exclusionReason: ForecastOccurrence['exclusionReason'];
      if (postponed) exclusionReason = 'postponed';
      else if (estimatedIncoming) exclusionReason = 'estimated_incoming';
      else if (plannedOutgoing) exclusionReason = 'planned_outgoing';

      if (occurrence.wasClampedFromPast) {
        sawClampedFromPast = true;
      }

      occurrences.push({
        occurrenceKey: `${event.id}@${occurrence.date}`,
        sourceEventId: event.id,
        occurrenceIndex: occurrence.index,
        isVirtual: occurrence.isVirtual,
        isSynthetic: event.isSynthetic === true,
        date: occurrence.date,
        name: event.name,
        direction: event.direction,
        amount: event.amount,
        requirement: event.requirement,
        certainty: event.certainty,
        status: event.status,
        countedInBalance: exclusionReason === undefined,
        exclusionReason,
        wasClampedFromPast: occurrence.wasClampedFromPast,
        ...(occurrence.originalDate
          ? { originalDate: occurrence.originalDate }
          : {}),
        financialGoalId: event.financialGoalId ?? null,
        debtId: event.debtId ?? null,
        settlementAssetId: event.settlementAssetId ?? null,
      });
    }
  }

  // 5. Sort. Outgoing before incoming on the SAME day is the conservative
  //    choice: we don't know the intraday order, and assuming the salary lands
  //    before the rent leaves would hide a real (if brief) shortfall.
  occurrences.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.direction !== b.direction) return a.direction === 'outgoing' ? -1 : 1;
    if (a.amount !== b.amount) return b.amount - a.amount;
    return a.sourceEventId < b.sourceEventId ? -1 : 1;
  });

  // 6/7. Day-by-day running balance. Empty days are emitted so the chart draws
  //      a continuous line.
  const byDate = new Map<string, ForecastOccurrence[]>();
  for (const occurrence of occurrences) {
    const list = byDate.get(occurrence.date);
    if (list) list.push(occurrence);
    else byDate.set(occurrence.date, [occurrence]);
  }

  const days: ForecastDay[] = [];
  let balance = startingLiquidBalance;
  let lowestProjectedBalance = startingLiquidBalance;
  let lowestProjectedBalanceDate = asOfDate;

  const totals = {
    upcomingIncomeAmount: 0,
    upcomingOutgoingAmount: 0,
    requiredOutgoingAmount: 0,
    plannedOutgoingAmount: 0,
    estimatedIncomingAmountExcluded: 0,
  };

  const dayCount = daysBetweenIso(asOfDate, horizonEndDate);
  for (let offset = 0; offset <= dayCount; offset += 1) {
    const date = addDaysIso(asOfDate, offset);
    const dayOccurrences = byDate.get(date) ?? [];
    const openingBalance = balance;
    let incoming = 0;
    let outgoing = 0;

    for (const occurrence of dayOccurrences) {
      if (occurrence.direction === 'incoming') {
        if (occurrence.countedInBalance) {
          incoming += occurrence.amount;
        } else if (occurrence.exclusionReason === 'estimated_incoming') {
          totals.estimatedIncomingAmountExcluded += occurrence.amount;
        }
      } else {
        if (occurrence.countedInBalance) {
          outgoing += occurrence.amount;
        }
        if (occurrence.requirement === 'required') {
          totals.requiredOutgoingAmount += occurrence.amount;
        } else if (occurrence.requirement === 'planned') {
          totals.plannedOutgoingAmount += occurrence.amount;
        }
      }
    }

    balance = openingBalance + incoming - outgoing;
    totals.upcomingIncomeAmount += incoming;
    totals.upcomingOutgoingAmount += outgoing;

    // Strictly less-than keeps the EARLIEST date on ties, which is the one the
    // household needs to act on.
    if (balance < lowestProjectedBalance) {
      lowestProjectedBalance = balance;
      lowestProjectedBalanceDate = date;
    }

    days.push({
      date,
      openingBalance: round(openingBalance),
      incoming: round(incoming),
      outgoing: round(outgoing),
      closingBalance: round(balance),
      occurrences: dayOccurrences,
    });
  }

  // 9. Obligation coverage: a second pass counting ONLY confirmed incoming and
  //    `required` outgoing. "Can we meet what we actually owe?" must not be
  //    answered false just because of discretionary plans.
  let requiredOnlyBalance = startingLiquidBalance;
  let obligationsCovered = requiredOnlyBalance >= 0;
  for (const occurrence of occurrences) {
    if (occurrence.direction === 'incoming') {
      if (occurrence.countedInBalance) {
        requiredOnlyBalance += occurrence.amount;
      }
    } else if (
      occurrence.requirement === 'required' &&
      occurrence.countedInBalance
    ) {
      requiredOnlyBalance -= occurrence.amount;
    }
    if (requiredOnlyBalance < 0) {
      obligationsCovered = false;
    }
  }

  // 10. The next inflow we're willing to bank on — flexible money needs it.
  const nextInflow = occurrences.find(
    (occurrence) =>
      occurrence.direction === 'incoming' && occurrence.countedInBalance,
  );

  // 11. Assumptions — codes only, never sentences.
  const staleAssetIds = usableNow
    .filter((asset) => {
      if (!asset.valueUpdatedAt) return true;
      return (
        daysBetweenIso(asset.valueUpdatedAt.slice(0, 10), asOfDate) >
        staleAfterDays
      );
    })
    .map((asset) => asset.assetId);

  const assumptions: CalculationAssumption[] = [
    { code: 'horizon_days', value: horizonDays },
    { code: 'same_day_outflows_ordered_first' },
  ];
  if (totals.estimatedIncomingAmountExcluded > 0) {
    assumptions.push({
      code: 'estimated_incoming_excluded',
      value: round(totals.estimatedIncomingAmountExcluded),
    });
  }
  if (includePlannedOutgoing && totals.plannedOutgoingAmount > 0) {
    assumptions.push({
      code: 'planned_outflows_included',
      value: round(totals.plannedOutgoingAmount),
    });
  }
  if (sawClampedFromPast) {
    assumptions.push({ code: 'overdue_events_clamped_to_today' });
  }
  if (staleAssetIds.length > 0) {
    assumptions.push({
      code: 'stale_asset_values',
      value: staleAssetIds.length,
      relatedIds: staleAssetIds,
    });
  }
  if (!nextInflow) {
    assumptions.push({ code: 'no_confirmed_inflow_in_horizon' });
  }

  return {
    householdId,
    asOfDate,
    horizonDays,
    horizonEndDate,
    startingLiquidBalance: round(startingLiquidBalance),
    // The very rows the balance was summed from, so an attribution of it cannot
    // disagree with it about what counted as liquid.
    liquidSources: usableNow,
    days,
    timeline: occurrences,
    totals: {
      upcomingIncomeAmount: round(totals.upcomingIncomeAmount),
      upcomingOutgoingAmount: round(totals.upcomingOutgoingAmount),
      requiredOutgoingAmount: round(totals.requiredOutgoingAmount),
      plannedOutgoingAmount: round(totals.plannedOutgoingAmount),
      estimatedIncomingAmountExcluded: round(
        totals.estimatedIncomingAmountExcluded,
      ),
    },
    lowestProjectedBalance: round(lowestProjectedBalance),
    lowestProjectedBalanceDate,
    endingProjectedBalance: round(balance),
    obligationsCovered,
    nextSufficientlyCertainInflow: nextInflow
      ? {
          date: nextInflow.date,
          amount: round(nextInflow.amount),
          sourceEventId: nextInflow.sourceEventId,
        }
      : null,
    staleAssetIds,
    usableNowAssetCount: usableNow.length,
    liveEventCount: eligible.length,
    assumptions,
  };
}

import type {
  Asset,
  AssetLiquidity,
  AssetType,
  AssetValuationMode,
} from '../../modules/assets/entities/asset.entity';
import type { CalculationTerm } from '../../modules/assets/entities/calculation-term.entity';
import type { FinancialGoal } from '../../modules/goals/entities/financial-goal.entity';
import type { FxRate } from '../../modules/market-data/entities/fx-rate.entity';
import type { MarketPrice } from '../../modules/market-data/entities/market-price.entity';

import type {
  MoneyDirection,
  MoneyEvent,
  MoneyEventType,
} from '../../modules/money-events/entities/money-event.entity';

const VALUATION_MODE_BY_TYPE: Record<AssetType, AssetValuationMode> = {
  cash: 'manual',
  bank_account: 'manual',
  saving_deposit: 'formula_calculated',
  certificate_of_deposit: 'formula_calculated',
  bond: 'formula_calculated',
  loan_receivable: 'formula_calculated',
  gold: 'market_priced',
  stock: 'market_priced',
  fund: 'market_priced',
  crypto: 'market_priced',
  foreign_currency: 'market_priced',
  real_estate: 'manual',
  insurance: 'manual',
  investment: 'manual',
  other: 'manual',
};

const LIQUIDITY_BY_ASSET_TYPE: Record<AssetType, AssetLiquidity> = {
  cash: 'usable_now',
  bank_account: 'usable_now',
  saving_deposit: 'not_immediately_usable',
  certificate_of_deposit: 'not_immediately_usable',
  bond: 'not_immediately_usable',
  loan_receivable: 'not_immediately_usable',
  gold: 'long_term',
  stock: 'long_term',
  fund: 'long_term',
  crypto: 'long_term',
  foreign_currency: 'not_immediately_usable',
  real_estate: 'long_term',
  insurance: 'long_term',
  investment: 'long_term',
  other: 'not_immediately_usable',
};

// ---------------------------------------------------------------------------
// Authorization lives in `HouseholdAccessGuard`, not here.
//
// There is no capability or visibility tier. Membership is the content
// permission — any member may read and write anything in their household —
// and the single exception is
// `@RequireHouseholdCreator()` for the three lifecycle operations. What holds a
// change accountable is the journal entry it leaves, not a permission grant.
//
// The tier machinery that used to sit here (PERMISSION_RANK, VISIBILITY_TIER,
// PERMISSION_VIEW_TIER, canViewVisibility, hasCapability, canEdit, canAdmin,
// effectivePermission) was fully written and fully unit-tested but never wired:
// `canViewVisibility` had exactly one caller, its own spec.
// ---------------------------------------------------------------------------

export function defaultValuationModeForAssetType(type: AssetType) {
  return VALUATION_MODE_BY_TYPE[type];
}

/** The bucket a type falls into when the household has not said otherwise. */
export function liquidityForAssetType(type: AssetType): AssetLiquidity {
  return LIQUIDITY_BY_ASSET_TYPE[type];
}

/**
 * Whether a type is spendable-now by default — i.e. the state the "counts
 * towards flexible money" switch starts in for that type.
 */
export function flexibleByDefaultForAssetType(type: AssetType): boolean {
  return LIQUIDITY_BY_ASSET_TYPE[type] === 'usable_now';
}

/**
 * The stored bucket, given the type and the household's explicit override.
 *
 * The type mapping answers "what kind of money is this", which is right often
 * enough to be the default and wrong often enough to need an escape hatch: cash
 * held for someone else is not spendable, and a gold bar the household would
 * genuinely sell this month is. `countsAsFlexible` records that decision;
 * `null` means "no decision — follow the type".
 *
 * The override lands in the STORED `liquidity` column rather than being a
 * second rule the forecast alone consults. Everything that answers "how much
 * money is usable now" — forecast, dashboard, the assets summary, snapshots —
 * already reads that column, so they cannot disagree. A per-record exclusion
 * known only to one consumer is what once left the dashboard and the forecast
 * reporting different totals (see CLAUDE.md, Authorization).
 */
export function liquidityForAsset(
  type: AssetType,
  countsAsFlexible?: boolean | null,
): AssetLiquidity {
  const derived = LIQUIDITY_BY_ASSET_TYPE[type];
  if (countsAsFlexible === true) return 'usable_now';
  if (countsAsFlexible === false && derived === 'usable_now') {
    // Excluded cash is still money the household has, just not money it counts
    // on — the middle bucket, never `long_term`.
    return 'not_immediately_usable';
  }
  return derived;
}

/**
 * Keep the column holding only real overrides: a flag that merely restates the
 * type's own default is stored as `null`, so an asset that was never given an
 * explicit answer keeps following its type (including after a type change).
 */
export function normalizeCountsAsFlexible(
  type: AssetType,
  countsAsFlexible?: boolean | null,
): boolean | null {
  if (countsAsFlexible === null || countsAsFlexible === undefined) return null;
  return countsAsFlexible === flexibleByDefaultForAssetType(type)
    ? null
    : countsAsFlexible;
}

/** Unit metadata that can be inferred without asking the user. */
export function marketUnitForAssetType(
  type: AssetType,
  symbol: string,
  enteredUnit = '',
): string {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (type === 'stock') return 'cổ';
  if (type === 'crypto' || type === 'foreign_currency') {
    return normalizedSymbol;
  }
  if (type === 'fund') return 'chứng chỉ';
  return enteredUnit.trim();
}

export function daysBetween(from: string, to: string): number {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 0;
  }

  return Math.max(0, Math.round((end - start) / 86_400_000));
}

export function formatDateLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

export function computeGoalProgress(goal: {
  currentAmount: number;
  targetAmount: number;
}) {
  if (goal.targetAmount <= 0) {
    return 0;
  }

  return Math.min(
    100,
    Math.round((goal.currentAmount / goal.targetAmount) * 100),
  );
}

export function deriveDirection(
  type: MoneyEventType,
  explicit?: MoneyDirection,
): MoneyDirection {
  if (explicit) {
    return explicit;
  }
  if (type === 'income') {
    return 'inflow';
  }
  if (type === 'expense') {
    return 'outflow';
  }
  if (type === 'debt_update') {
    return 'outflow';
  }
  // Completing an outgoing cashflow event records a `payment_paid`. Money left
  // the household, so it is spending — falling through to `neutral` kept it out
  // of the month's chi and out of the debt's repaid total.
  if (type === 'payment_paid') {
    return 'outflow';
  }
  if (type === 'adjustment') {
    // A balance reconcile is a bookkeeping correction, not money moving — it
    // must not touch a wallet or auto-reduce a debt (both are outflow-gated).
    return 'neutral';
  }
  return 'neutral';
}

export function makeInitials(nameOrEmail: string) {
  const source = nameOrEmail.includes('@')
    ? nameOrEmail.split('@')[0]
    : nameOrEmail;
  const parts = source
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0] ?? '');
  return (letters.join('') || source.slice(0, 2)).toUpperCase();
}

export function quoteFor(
  marketPrices: MarketPrice[],
  assetClass: string,
  symbol: string,
) {
  return marketPrices.find(
    (price) =>
      price.assetClass === assetClass &&
      price.symbol.toUpperCase() === symbol.toUpperCase(),
  );
}

/**
 * Convert 1 unit of `currency` to VND.
 *
 * Returns `null` when the rate is unknown — the caller must treat that as
 * "value undefined", NOT as 1. The old `?? 1` fallback silently priced e.g. 1
 * USD = 1 VND when a rate was missing, understating a foreign holding ~25,000×.
 * VND→VND is always 1 (no FX row needed).
 */
export function fxRateToVnd(
  fxRates: FxRate[],
  currency: string,
): number | null {
  if (currency.toUpperCase() === 'VND') {
    return 1;
  }
  const match = fxRates.find(
    (rate) =>
      rate.baseCurrency.toUpperCase() === currency.toUpperCase() &&
      rate.quoteCurrency === 'VND',
  );
  return match?.rate ?? null;
}

export function computeCurrentValue(
  asset: Asset,
  marketPrices: MarketPrice[],
  fxRates: FxRate[],
  asOf: string,
) {
  if (asset.valuationMode === 'manual') {
    return asset.manualValue ?? 0;
  }

  if (asset.valuationMode === 'market_priced' && asset.marketPosition) {
    const { purchasePrice, lastPrice, quoteCurrency, quantity } =
      asset.marketPosition;

    // A manually recorded latest price wins. Otherwise prefer the market cache;
    // the original purchase price is only the final fallback/cost basis.
    if (typeof lastPrice === 'number' && Number.isFinite(lastPrice)) {
      const fx = fxRateToVnd(fxRates, quoteCurrency);
      // Unknown FX rate → value undefined; return 0 rather than mis-price it.
      return fx === null ? 0 : quantity * lastPrice * fx;
    }

    const quote = quoteFor(
      marketPrices,
      asset.marketPosition.assetClass,
      asset.marketPosition.symbol,
    );
    if (quote) {
      const fx = fxRateToVnd(fxRates, quote.quoteCurrency);
      return fx === null ? 0 : quantity * quote.price * fx;
    }

    if (typeof purchasePrice === 'number' && Number.isFinite(purchasePrice)) {
      const fx = fxRateToVnd(fxRates, quoteCurrency);
      return fx === null ? 0 : quantity * purchasePrice * fx;
    }
    return 0;
  }

  if (asset.valuationMode === 'formula_calculated' && asset.calculationTerm) {
    const effectiveEnd =
      asset.calculationTerm.maturityDate &&
      new Date(asset.calculationTerm.maturityDate) < new Date(asOf)
        ? asset.calculationTerm.maturityDate
        : asOf;
    const elapsedYears =
      daysBetween(asset.calculationTerm.startDate, effectiveEnd) / 365;
    const rate = asset.calculationTerm.interestRate / 100;
    const accrued = asset.calculationTerm.principalAmount * rate * elapsedYears;
    return asset.calculationTerm.principalAmount + accrued;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Saving-deposit withdrawal projections (display-only, §savings)
//
// Derived on demand from the calculation term — these are NOT persisted into
// `asset_value_history` / `currentValue`; `computeCurrentValue` above stays the
// single source of a saving asset's stored value.
// ---------------------------------------------------------------------------

export interface SavingBreakdown {
  principal: number;
  /** Interest received (negative = clawed back from principal). */
  interest: number;
  /** Amount the depositor takes home. */
  total: number;
}

/** Term length of a saving deposit in years (derived from start→maturity). */
export function savingTermYears(term: CalculationTerm): number {
  if (!term.maturityDate) {
    return 0;
  }
  return daysBetween(term.startDate, term.maturityDate) / 365;
}

/** Term length in whole months (for the withdraw-month control). */
export function savingTermMonths(term: CalculationTerm): number {
  return Math.round(savingTermYears(term) * 12);
}

/** Payout when the deposit is held to maturity (rút đúng hạn). */
export function computeSavingOnTime(term: CalculationTerm): SavingBreakdown {
  const principal = term.principalAmount;
  const rate = term.interestRate / 100;
  const interest = principal * rate * savingTermYears(term);
  // end_of_term and monthly yield the same total interest at maturity; for
  // `monthly` it was already paid out over the term, then principal is returned.
  return { principal, interest, total: principal + interest };
}

/**
 * Payout when the deposit is withdrawn early at month `withdrawMonth`
 * (rút trước hạn). The contracted rate is void — the non-term rate applies to
 * the elapsed period. For a `monthly` payout the bank claws back interest it
 * already paid at the contracted rate.
 */
export function computeSavingEarly(
  term: CalculationTerm,
  withdrawMonth: number,
): SavingBreakdown {
  const principal = term.principalAmount;
  const contractRate = term.interestRate / 100;
  const nonTerm = term.nonTermRate / 100;
  const n = withdrawMonth;
  const actualInterest = principal * nonTerm * (n / 12);

  if (term.interestPayment === 'end_of_term') {
    return {
      principal,
      interest: actualInterest,
      total: principal + actualInterest,
    };
  }

  // monthly: interest was paid at the contracted rate; claw back the excess.
  const interestAlreadyPaid = principal * contractRate * (n / 12);
  const clawback = interestAlreadyPaid - actualInterest;
  return { principal, interest: -clawback, total: principal - clawback };
}

/** One due interest payout: the period-end date and the amount to credit. */
export interface SavingInterestPeriod {
  /** ISO date (YYYY-MM-DD) the interest becomes due. Idempotency key. */
  periodEnd: string;
  amount: number;
}

/** Add `months` calendar months to an ISO date, clamped to the month's length. */
function addMonthsIso(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1),
  );
  // Clamp to the last valid day of the target month (e.g. Jan 31 → Feb 28).
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The interest payouts that have become due for a saving deposit as of `asOf`,
 * for the auto-crediting flow. Pure and deterministic — the caller materializes
 * each period into a money event + valuation, keyed by `periodEnd` so re-runs
 * are idempotent.
 *
 * - `monthly`: one payout per whole month elapsed from `startDate`, each
 *   `principal × rate / 12`, capped at `maturityDate` and at `asOf`.
 * - `end_of_term`: a single payout of the full-term interest, due only once
 *   `asOf` has reached `maturityDate`.
 *
 * Returns `[]` when there is no maturity date or nothing is due yet.
 */
export function computeSavingInterestPeriods(
  term: CalculationTerm,
  asOf: string,
): SavingInterestPeriod[] {
  if (!term.maturityDate) {
    return [];
  }
  const principal = term.principalAmount;
  const rate = term.interestRate / 100;
  const maturity = term.maturityDate;
  // Interest never accrues past maturity.
  const horizon = maturity < asOf ? maturity : asOf;

  if (term.interestPayment === 'end_of_term') {
    // Due only once the term has fully matured.
    if (asOf < maturity) {
      return [];
    }
    const years = daysBetween(term.startDate, maturity) / 365;
    return [{ periodEnd: maturity, amount: principal * rate * years }];
  }

  // monthly: walk month boundaries from the start date up to the horizon.
  const monthly = (principal * rate) / 12;
  const periods: SavingInterestPeriod[] = [];
  for (let month = 1; ; month += 1) {
    const periodEnd = addMonthsIso(term.startDate, month);
    if (periodEnd > horizon) {
      break;
    }
    periods.push({ periodEnd, amount: monthly });
  }
  return periods;
}

export function computeLiquidityTotals(
  assets: Array<{ liquidity: AssetLiquidity; currentValue: number }>,
) {
  const totals = {
    usable_now: 0,
    not_immediately_usable: 0,
    long_term: 0,
    totalAssets: 0,
  };

  for (const asset of assets) {
    totals[asset.liquidity] += asset.currentValue;
    totals.totalAssets += asset.currentValue;
  }

  return totals;
}

export type SnapshotSourceMode = 'manual' | 'calculated' | 'mixed';

// `deriveSnapshotStatus` and its `good | attention | tight | insufficient_data`
// enum were REMOVED in the v3.1 alignment.
//
// It judged a snapshot on net worth and whether liquid cash covered what was
// due — a balance-sheet reading, taken before the product had a forecast.
// v3.1's state is `on_track | watch | tight | incomplete` and comes from the
// projected balance, so the two would have disagreed on the same household:
// positive net worth with a shortfall on the 15th read as `good` under the old
// rule and `tight` under the new one.
//
// Live state now comes from `forecast/domain/financial-state.ts`; a stored
// snapshot's state comes from `snapshots/domain/snapshot-financial-state.ts`,
// derived from its own frozen foresight columns. Both share
// `FINANCIAL_STATE_THRESHOLDS`, so history and today can never disagree about
// what "tight" means.

/**
 * Derive the source mode from the valuation methods that fed the snapshot:
 * all user-entered → `manual`, all derived (market/formula) → `calculated`,
 * a mix → `mixed`.
 */
export function deriveSnapshotSourceMode(
  methods: Array<string | null | undefined>,
): SnapshotSourceMode {
  let hasManual = false;
  let hasDerived = false;
  for (const method of methods) {
    if (method === 'manual' || method === 'statement' || !method) {
      hasManual = true;
    } else {
      hasDerived = true;
    }
  }
  if (hasManual && hasDerived) return 'mixed';
  return hasDerived ? 'calculated' : 'manual';
}

export function toMoneyEventCard(event: MoneyEvent) {
  // Money values are returned as raw numbers; the client formats them for
  // display. `amount` keeps its sign (inflow > 0, outflow < 0).
  return {
    id: event.id,
    amount: event.amount,
    feeAmount: event.feeAmount ?? 0,
    // Sale specifics, so an edit can prefill/preserve them (undefined for
    // non-sale events).
    soldQuantity: event.soldQuantity,
    soldValue: event.soldValue,
    note: event.note,
    date: formatDateLabel(event.isoDate),
    isoDate: event.isoDate,
    type: event.type,
    category: event.category,
    direction: event.direction,
    fromAssetId: event.fromAssetId,
    toAssetId: event.toAssetId,
    upcomingPaymentId: event.upcomingPaymentId,
    debtId: event.debtId,
  };
}

/**
 * The wire shape of a goal.
 *
 * `progressAmount` is the money actually behind the goal, resolved by the
 * caller via `resolveGoalProgressAmount` — a sum over its allocations at live
 * asset values. A goal stores no figure of its own, so this is the only source
 * of the number; it is required in practice and defaults to 0 only for a goal
 * read before its allocations were loaded.
 *
 * It is emitted as `currentAmount` so every client surface keeps reading one
 * field.
 *
 * `plannedMonthlyContribution` comes straight off the goal: unlike progress it
 * IS stored, as a mirror of the goal's wallet shares that `GoalsService` keeps
 * in step, so every surface can show the pace without reading allocations.
 */
export function toGoalCard(goal: FinancialGoal, progressAmount = 0) {
  // Raw numeric amounts; the client formats them.
  const currentAmount = progressAmount;
  return {
    id: goal.id,
    name: goal.name,
    currentAmount,
    targetAmount: goal.targetAmount,
    plannedMonthlyContribution: goal.plannedMonthlyContribution,
    progress: computeGoalProgress({
      currentAmount,
      targetAmount: goal.targetAmount,
    }),
    priority: goal.priority,
    note: goal.note,
    targetDate: goal.targetDate,
  };
}

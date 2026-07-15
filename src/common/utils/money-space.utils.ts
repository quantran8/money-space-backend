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
  HouseholdRole,
  PermissionLevel,
} from '../../modules/members/entities/member.entity';

export type VisibilityLevel = 'summary_only' | 'grouped' | 'detail' | 'private';
import type {
  MoneyDirection,
  MoneyEvent,
  MoneyEventType,
} from '../../modules/money-events/entities/money-event.entity';
import type {
  PaymentUiStatus,
  UpcomingPayment,
} from '../../modules/payments/entities/upcoming-payment.entity';

const DEFAULT_PERMISSION_FOR_ROLE: Record<HouseholdRole, PermissionLevel> = {
  owner: 'admin',
  partner: 'edit_content',
  viewer: 'view_summary',
};

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

export function defaultPermissionForRole(role: HouseholdRole) {
  return DEFAULT_PERMISSION_FOR_ROLE[role];
}

// ---------------------------------------------------------------------------
// Authorization (app-layer; NOT Postgres RLS — the project stays DB-portable).
//
// Two axes:
//   1. Capability — what a member may DO, from their PermissionLevel (which is
//      derived from role unless a per-member override is set).
//   2. Visibility — how sensitive a record is (VisibilityLevel), gated against
//      the viewer's own permission tier.
// ---------------------------------------------------------------------------

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  view_summary: 0,
  view_grouped: 1,
  view_detail: 2,
  edit_content: 3,
  admin: 4,
};

/** The effective permission: the override if set, else derived from role. */
export function effectivePermission(
  role: HouseholdRole,
  override?: PermissionLevel | null,
): PermissionLevel {
  return override ?? defaultPermissionForRole(role);
}

/** Can this permission create/update/delete content? */
export function canEdit(permission: PermissionLevel): boolean {
  return PERMISSION_RANK[permission] >= PERMISSION_RANK.edit_content;
}

/** Can this permission manage members / household settings? */
export function canAdmin(permission: PermissionLevel): boolean {
  return PERMISSION_RANK[permission] >= PERMISSION_RANK.admin;
}

export type Capability = 'view' | 'edit' | 'admin';

export function hasCapability(
  permission: PermissionLevel,
  capability: Capability,
): boolean {
  if (capability === 'admin') return canAdmin(permission);
  if (capability === 'edit') return canEdit(permission);
  return true; // any member can view (visibility is gated separately)
}

// Sensitivity tiers, low → high. `private` is a separate flag (creator/admin only).
const VISIBILITY_TIER: Record<VisibilityLevel, number> = {
  summary_only: 0,
  grouped: 1,
  detail: 2,
  private: 99,
};

// A viewer's permission maps to the highest record tier they may see.
const PERMISSION_VIEW_TIER: Record<PermissionLevel, number> = {
  view_summary: 0,
  view_grouped: 1,
  view_detail: 2,
  edit_content: 2,
  admin: 2,
};

/**
 * May a viewer see a record of the given visibility?
 * `visible = viewer.tier >= record.tier AND (record != private OR viewer is creator/admin)`.
 */
export function canViewVisibility(
  permission: PermissionLevel,
  visibility: VisibilityLevel,
  opts?: { isCreator?: boolean },
): boolean {
  if (visibility === 'private') {
    return opts?.isCreator === true || canAdmin(permission);
  }
  return PERMISSION_VIEW_TIER[permission] >= VISIBILITY_TIER[visibility];
}

export function defaultValuationModeForAssetType(type: AssetType) {
  return VALUATION_MODE_BY_TYPE[type];
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

export type SnapshotStatus =
  'good' | 'attention' | 'tight' | 'insufficient_data';
export type SnapshotSourceMode = 'manual' | 'calculated' | 'mixed';

/**
 * Derive a snapshot's health status from its frozen totals. Not stored on the
 * row — computed here at read time so the thresholds can evolve without a
 * migration and can never go stale.
 */
export function deriveSnapshotStatus(input: {
  totalAssets: number;
  totalDebt: number;
  totalLiquid: number;
  upcomingDueAmount: number;
  attentionCount: number;
  assetCount: number;
}): SnapshotStatus {
  if (input.assetCount === 0) {
    return 'insufficient_data';
  }
  const netWorth = input.totalAssets - input.totalDebt;
  // Can the household cover what's due soon from cash it can use now?
  const liquidCoversDue = input.totalLiquid >= input.upcomingDueAmount;
  if (netWorth <= 0 || !liquidCoversDue) {
    return 'tight';
  }
  if (input.attentionCount > 0) {
    return 'attention';
  }
  return 'good';
}

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
    financialGoalId: event.financialGoalId,
  };
}

export function toPaymentCard(payment: UpcomingPayment) {
  // Raw numeric `amount`; the client formats it for display.
  return {
    id: payment.id,
    name: payment.name,
    amount: payment.amount,
    due: formatDateLabel(payment.dueDate),
    dueDate: payment.dueDate,
    owner: payment.owner,
    debtId: payment.debtId,
    status: payment.status,
  };
}

export function toGoalCard(goal: FinancialGoal) {
  // Raw numeric `currentAmount` / `targetAmount`; the client formats them.
  return {
    id: goal.id,
    name: goal.name,
    currentAmount: goal.currentAmount,
    targetAmount: goal.targetAmount,
    progress: computeGoalProgress(goal),
    priority: goal.priority,
    note: goal.note,
    deadline: goal.deadline,
  };
}

export function normalizePaymentStatus(
  status: PaymentUiStatus | undefined,
): PaymentUiStatus {
  return status ?? 'normal';
}

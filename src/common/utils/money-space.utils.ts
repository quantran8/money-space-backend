import type {
  Asset,
  AssetLiquidity,
  AssetType,
  AssetValuationMode,
} from '../../modules/assets/entities/asset.entity';
import type { FinancialGoal } from '../../modules/goals/entities/financial-goal.entity';
import type { FxRate } from '../../modules/market-data/entities/fx-rate.entity';
import type { MarketPrice } from '../../modules/market-data/entities/market-price.entity';
import type {
  HouseholdRole,
  PermissionLevel,
} from '../../modules/members/entities/member.entity';
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

export function formatCompactMillions(value: number): string {
  const millions = value / 1_000_000;
  const fractionDigits = Number.isInteger(millions) ? 0 : 1;
  return `${new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(millions)}M`;
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
  return 'neutral';
}

export function makeInitials(nameOrEmail: string) {
  const source = nameOrEmail.includes('@')
    ? nameOrEmail.split('@')[0]
    : nameOrEmail;
  const parts = source.trim().split(/[\s._-]+/).filter(Boolean);
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

export function fxRateToVnd(fxRates: FxRate[], currency: string): number {
  const match = fxRates.find(
    (rate) =>
      rate.baseCurrency.toUpperCase() === currency.toUpperCase() &&
      rate.quoteCurrency === 'VND',
  );
  return match?.rate ?? 1;
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
    const quote = quoteFor(
      marketPrices,
      asset.marketPosition.assetClass,
      asset.marketPosition.symbol,
    );
    if (!quote) {
      return 0;
    }

    return (
      asset.marketPosition.quantity *
      quote.price *
      fxRateToVnd(fxRates, quote.quoteCurrency)
    );
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

export function toMoneyEventCard(event: MoneyEvent) {
  return {
    id: event.id,
    title: event.title,
    amount: `${event.amount >= 0 ? '+' : '-'}${formatCompactMillions(
      Math.abs(event.amount),
    )}`,
    amountValue: event.amount,
    note: event.note,
    date: formatDateLabel(event.isoDate),
    isoDate: event.isoDate,
    type: event.type,
    category: event.category,
    direction: event.direction,
    fromAssetId: event.fromAssetId,
    toAssetId: event.toAssetId,
    upcomingPaymentId: event.upcomingPaymentId,
    financialGoalId: event.financialGoalId,
  };
}

export function toPaymentCard(payment: UpcomingPayment) {
  return {
    id: payment.id,
    name: payment.name,
    amount: formatCompactMillions(payment.amount),
    amountValue: payment.amount,
    due: formatDateLabel(payment.dueDate),
    dueDate: payment.dueDate,
    owner: payment.owner,
    status: payment.status,
  };
}

export function toGoalCard(goal: FinancialGoal) {
  return {
    id: goal.id,
    name: goal.name,
    current: formatCompactMillions(goal.currentAmount),
    currentAmount: goal.currentAmount,
    target: formatCompactMillions(goal.targetAmount),
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

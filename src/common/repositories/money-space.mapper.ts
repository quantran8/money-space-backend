import type { Asset } from '../../modules/assets/entities/asset.entity';
import type { AssetValueHistory } from '../../modules/assets/entities/asset-value-history.entity';
import type { AttentionItem } from '../../modules/dashboard/entities/attention-item.entity';
import type { SnapshotPoint } from '../../modules/dashboard/entities/snapshot-point.entity';
import type {
  Debt,
  DebtInterestPeriod,
} from '../../modules/debts/entities/debt.entity';
import type { FinancialGoal } from '../../modules/goals/entities/financial-goal.entity';
import type {
  Household,
  HouseholdConfig,
} from '../../modules/households/entities/household.entity';
import type { FxRate } from '../../modules/market-data/entities/fx-rate.entity';
import type { HouseholdMember } from '../../modules/members/entities/member.entity';
import type { MoneyEventCategory } from '../../modules/money-event-categories/entities/money-event-category.entity';
import type { MoneyEvent } from '../../modules/money-events/entities/money-event.entity';
import type { UpcomingPayment } from '../../modules/payments/entities/upcoming-payment.entity';
import { defaultPermissionForRole } from '../utils/money-space.utils';
import { DbRow } from './prisma.repository';

/**
 * System (global) money-event categories seeded for every household. Kept in
 * sync with the `money_event_categories` seed in the migration. `interest` is
 * included (saving-deposit interest events use it) — the old fixed enum omitted
 * it, so it was silently coerced to `other`.
 */
export const SYSTEM_MONEY_EVENT_CATEGORIES: ReadonlyArray<string> = [
  'housing',
  'education',
  'transport',
  'health',
  'family_support',
  'insurance',
  'saving',
  'investment',
  'debt',
  'income',
  'interest',
  'repair',
  'household',
  'children',
  'travel',
  'other',
];

export function numberFromDb(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }

  return Number(value);
}

export function dateOnly(value: unknown): string {
  if (!value) {
    return '';
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

export function nullableDate(value: string | null | undefined) {
  return value && value !== 'No deadline' ? value : null;
}

/**
 * `category` is now a free-form CODE (backed by the `money_event_categories`
 * table, not a Postgres enum). Keep any non-empty, well-formed code as-is —
 * existence against the household's + system categories is validated at the
 * service layer. Falls back to `other` only when empty/blank.
 *
 * Note: this replaces the old enum coercion, which silently rewrote codes not
 * in the fixed enum (e.g. `interest`, used for saving-deposit interest events)
 * to `other` — a real data-loss bug.
 */
export function normalizeMoneyEventCategory(category?: string): string {
  const code = category?.trim();
  return code && code.length > 0 ? code : 'other';
}

/**
 * Normalize the `households.config` jsonb into a typed {@link HouseholdConfig}.
 * Prisma returns jsonb already parsed (object), but a raw SQL path may hand back
 * a string — tolerate both, and never throw on malformed data (fall back to {}).
 */
function mapHouseholdConfig(value: unknown): HouseholdConfig {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const source = raw as Record<string, unknown>;
  const config: HouseholdConfig = {};
  const defaultCode = source.defaultEventCategoryCode;
  if (typeof defaultCode === 'string' && defaultCode.length > 0) {
    config.defaultEventCategoryCode = defaultCode;
  }
  return config;
}

export function mapHousehold(row: DbRow): Household {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    updateFrequency: row.updateFrequency ?? row.update_frequency,
    config: mapHouseholdConfig(row.config),
    createdBy: row.createdById ?? row.created_by,
    createdAt: row.createdAt ?? row.created_at,
  };
}

export function mapMoneyEventCategory(row: DbRow): MoneyEventCategory {
  return {
    id: row.id,
    householdId: row.householdId ?? row.household_id ?? null,
    code: row.code,
    label: row.label,
    isSystem: row.isSystem ?? row.is_system ?? false,
    sortOrder: row.sortOrder ?? row.sort_order ?? 0,
    // Default-ness is per-household (pointer on households.config), not a row
    // column — the service overlays the true value from the household's config.
    isDefault: false,
  };
}

export function mapMember(
  row: DbRow,
  profile: DbRow | undefined,
  makeInitials: (value: string) => string,
): HouseholdMember {
  const name =
    profile?.displayName ??
    profile?.display_name ??
    profile?.fullName ??
    profile?.full_name ??
    profile?.email ??
    row.userId ??
    row.user_id;
  const email = profile?.email ?? '';

  return {
    id: row.id,
    profileId: row.userId ?? row.user_id,
    householdId: row.householdId ?? row.household_id,
    name,
    email,
    initials: makeInitials(name || email),
    role: row.role,
    // permission_level is a nullable OVERRIDE; NULL → derive from role.
    permission:
      row.permissionLevel ??
      row.permission_level ??
      defaultPermissionForRole(row.role),
    joinedAt: row.joinedAt ?? row.joined_at,
    lastActive: row.updatedAt ?? row.updated_at,
    status: (row.status as 'active' | 'invited') ?? 'active',
  };
}

export function mapAsset(row: DbRow, position?: DbRow, term?: DbRow): Asset {
  const valuationMode = row.valuationMode ?? row.valuation_mode;

  return {
    id: row.id,
    householdId: row.householdId ?? row.household_id,
    name: row.name,
    type: row.type,
    valuationMode,
    liquidity: row.liquidity,
    currency: row.currency,
    note: row.note ?? '',
    status: row.status ?? 'active',
    soldAt:
      (row.soldAt ?? row.sold_at)
        ? dateOnly(row.soldAt ?? row.sold_at)
        : undefined,
    manualValue:
      valuationMode === 'manual'
        ? numberFromDb(row.currentValue ?? row.current_value)
        : undefined,
    marketPosition: position
      ? {
          assetClass: position.assetClass ?? position.asset_class,
          symbol: position.symbol,
          quantity: numberFromDb(position.quantity),
          unit: position.unit,
          quoteCurrency: position.quoteCurrency ?? position.quote_currency,
          // Keep undefined (not 0) when unset, so valuation can fall back to
          // the cached market price rather than reading the position as free.
          purchasePrice:
            (position.purchasePrice ?? position.purchase_price) != null
              ? numberFromDb(position.purchasePrice ?? position.purchase_price)
              : undefined,
          lastPrice:
            (position.lastPrice ?? position.last_price) != null
              ? numberFromDb(position.lastPrice ?? position.last_price)
              : undefined,
          lastPriceAt:
            (position.lastPriceAt ?? position.last_price_at) != null
              ? new Date(
                  position.lastPriceAt ?? position.last_price_at,
                ).toISOString()
              : undefined,
        }
      : undefined,
    areaSqm:
      (row.areaSqm ?? row.area_sqm) != null
        ? numberFromDb(row.areaSqm ?? row.area_sqm)
        : undefined,
    calculationTerm: term
      ? {
          calculationType: term.calculationType ?? term.calculation_type,
          principalAmount: numberFromDb(
            term.principalAmount ?? term.principal_amount,
          ),
          interestRate: numberFromDb(term.interestRate ?? term.interest_rate),
          startDate: dateOnly(term.startDate ?? term.start_date),
          maturityDate:
            (term.maturityDate ?? term.maturity_date)
              ? dateOnly(term.maturityDate ?? term.maturity_date)
              : null,
          // Payout schedule reuses the `payoutFrequency` column:
          // monthly ↔ monthly, everything else (at_maturity/null) ↔ end_of_term.
          interestPayment:
            (term.payoutFrequency ?? term.payout_frequency) === 'monthly'
              ? 'monthly'
              : 'end_of_term',
          nonTermRate:
            (term.nonTermRate ?? term.non_term_rate) != null
              ? numberFromDb(term.nonTermRate ?? term.non_term_rate)
              : 0,
          interestDestination:
            (term.interestDestination ?? term.interest_destination) === 'wallet'
              ? 'wallet'
              : 'principal',
          receivingWalletId:
            term.receivingWalletId ?? term.receiving_wallet_id ?? null,
        }
      : undefined,
  };
}

export function mapAssetValueHistory(row: DbRow): AssetValueHistory {
  return {
    id: row.id,
    assetId: row.assetId ?? row.asset_id,
    householdId: row.householdId ?? row.household_id,
    valuationDate: dateOnly(row.valuationDate ?? row.valuation_date),
    value: numberFromDb(row.value),
    currency: row.currency,
    method: row.valuationMethod ?? row.valuation_method,
    note: row.note ?? '',
    source: row.source ?? undefined,
    confidenceLevel: row.confidenceLevel ?? row.confidence_level ?? undefined,
    fxRateId: row.fxRateId ?? row.fx_rate_id ?? undefined,
    calculationTermId:
      row.calculationTermId ?? row.calculation_term_id ?? undefined,
    moneyEventId: row.moneyEventId ?? row.money_event_id ?? undefined,
  };
}

export function mapSnapshot(row: DbRow): SnapshotPoint {
  return {
    id: row.id,
    householdId: row.householdId ?? row.household_id,
    date: dateOnly(row.snapshotDate ?? row.snapshot_date),
    usableNow: numberFromDb(row.totalLiquid ?? row.total_liquid),
    notImmediatelyUsable: numberFromDb(row.totalSavings ?? row.total_savings),
    longTerm: numberFromDb(
      row.totalLongTermAssets ?? row.total_long_term_assets,
    ),
    totalDebt: numberFromDb(row.totalDebt ?? row.total_debt),
    attentionCount: numberFromDb(row.attentionCount ?? row.attention_count),
  };
}

export function mapFxRate(row: DbRow): FxRate {
  return {
    baseCurrency: row.baseCurrency ?? row.base_currency,
    quoteCurrency: row.quoteCurrency ?? row.quote_currency,
    rate: numberFromDb(row.rate),
    asOf: row.rateTime ?? row.rate_time,
    source: row.source,
  };
}

export function mapAttentionItem(row: DbRow): AttentionItem {
  return {
    id: row.id,
    householdId: row.householdId ?? row.household_id,
    title: row.title,
    reason: row.reason ?? '',
    level: row.level,
  };
}

export function mapFinancialGoal(row: DbRow): FinancialGoal {
  return {
    id: row.id,
    householdId: row.householdId ?? row.household_id,
    name: row.name,
    currentAmount: numberFromDb(row.currentAmount ?? row.current_amount),
    targetAmount: numberFromDb(row.targetAmount ?? row.target_amount),
    priority: row.priority,
    note: row.note ?? '',
    deadline: row.deadline ? dateOnly(row.deadline) : 'No deadline',
  };
}

function mapInterestPeriod(period: DbRow): DebtInterestPeriod {
  const startRaw = period.startDate ?? period.start_date;
  const endRaw = period.endDate ?? period.end_date;
  const months = period.termMonths ?? period.term_months;
  return {
    interestRate: numberFromDb(period.interestRate ?? period.interest_rate),
    startDate: startRaw ? dateOnly(startRaw) : undefined,
    endDate: endRaw ? dateOnly(endRaw) : undefined,
    months:
      months === null || months === undefined ? undefined : Number(months),
  };
}

export function mapDebt(row: DbRow, period?: DbRow, periods?: DbRow[]): Debt {
  const paymentFrequency =
    row.paymentFrequency ?? row.payment_frequency ?? undefined;
  const fixedRaw = row.fixedPaymentAmount ?? row.fixed_payment_amount;
  const minRaw = row.minimumPaymentAmount ?? row.minimum_payment_amount;
  return {
    id: row.id,
    householdId: row.householdId ?? row.household_id,
    name: row.name,
    lenderType: row.lenderType ?? row.lender_type,
    lenderName: row.lenderName ?? row.lender_name ?? undefined,
    originalAmount: numberFromDb(row.originalAmount ?? row.original_amount),
    outstandingAmount: numberFromDb(
      row.outstandingAmount ?? row.outstanding_amount,
    ),
    currency: row.currency ?? 'VND',
    borrowedAt:
      (row.borrowedAt ?? row.borrowed_at)
        ? dateOnly(row.borrowedAt ?? row.borrowed_at)
        : undefined,
    expectedFinalDueDate:
      (row.expectedFinalDueDate ?? row.expected_final_due_date)
        ? dateOnly(row.expectedFinalDueDate ?? row.expected_final_due_date)
        : undefined,
    status: row.status,
    ownerMemberId: row.ownerMemberId ?? row.owner_member_id ?? undefined,
    receivedToAssetId:
      row.receivedToAssetId ?? row.received_to_asset_id ?? undefined,
    // Repayment terms now live directly on the debts row (folded in from
    // debt_terms).
    paymentFrequency,
    fixedPaymentAmount:
      fixedRaw === null || fixedRaw === undefined
        ? undefined
        : numberFromDb(fixedRaw),
    minimumPaymentAmount:
      minRaw === null || minRaw === undefined
        ? undefined
        : numberFromDb(minRaw),
    interestType: row.interestType ?? row.interest_type ?? undefined,
    interestCalculation:
      row.interestCalculation ?? row.interest_calculation ?? undefined,
    interestRate: period
      ? numberFromDb(period.interestRate ?? period.interest_rate)
      : undefined,
    interestPeriods:
      periods && periods.length > 0
        ? periods.map(mapInterestPeriod)
        : undefined,
    note: row.note ?? undefined,
  };
}

export function mapMoneyEvent(row: DbRow): MoneyEvent {
  return {
    id: row.id,
    householdId: row.householdId ?? row.household_id,
    amount: numberFromDb(row.amount),
    feeAmount: numberFromDb(row.feeAmount ?? row.fee_amount ?? 0),
    soldQuantity:
      (row.soldQuantity ?? row.sold_quantity) != null
        ? numberFromDb(row.soldQuantity ?? row.sold_quantity)
        : undefined,
    soldValue:
      (row.soldValue ?? row.sold_value) != null
        ? numberFromDb(row.soldValue ?? row.sold_value)
        : undefined,
    note: row.description ?? '',
    isoDate: dateOnly(row.eventDate ?? row.event_date),
    type: row.eventType ?? row.event_type,
    category: row.category,
    direction: row.direction,
    fromAssetId: row.fromAssetId ?? row.from_asset_id ?? undefined,
    toAssetId: row.toAssetId ?? row.to_asset_id ?? undefined,
    upcomingPaymentId:
      row.upcomingPaymentId ?? row.upcoming_payment_id ?? undefined,
    debtId: row.debtId ?? row.debt_id ?? undefined,
    financialGoalId: row.financialGoalId ?? row.financial_goal_id ?? undefined,
  };
}

export function mapUpcomingPayment(row: DbRow): UpcomingPayment {
  return {
    id: row.id,
    householdId: row.householdId ?? row.household_id,
    name: row.name,
    amount: numberFromDb(row.amount),
    dueDate: dateOnly(row.dueDate ?? row.due_date),
    owner: row.ownerMemberId ?? row.owner_member_id ?? 'Chua phan cong',
    debtId: row.debtId ?? row.debt_id ?? undefined,
    status: toUiPaymentStatus(
      row.status,
      row.attentionLevel ?? row.attention_level,
    ),
  };
}

// `attentionLevel` carries the UI's "important" flag (PaymentStatus has no such
// value), so it is a real stored input. `isAttentionNeeded` was a pure derived
// mirror (= attentionLevel === 'important') and has been dropped.
export function toPaymentStatusFields(status: UpcomingPayment['status']) {
  if (status === 'pending') {
    return { status: 'pending_confirmation', attentionLevel: 'normal' };
  }

  return {
    status: 'unpaid',
    attentionLevel: status === 'important' ? 'important' : 'normal',
  };
}

function toUiPaymentStatus(
  status: string,
  attentionLevel: string,
): UpcomingPayment['status'] {
  if (status === 'pending_confirmation') {
    return 'pending';
  }

  return attentionLevel === 'important' ? 'important' : 'normal';
}

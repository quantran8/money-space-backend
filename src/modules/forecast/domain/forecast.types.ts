import type { IsoDate } from '../../../common/utils/clock';
import type { RecurrenceFrequency } from '../../../common/utils/recurrence';
import type {
  CashflowCertainty,
  CashflowDirection,
  CashflowEventStatus,
  CashflowRequirement,
} from '../../cashflow-events/entities/cashflow-event.entity';

/**
 * A machine-readable reason a number is what it is.
 *
 * NEVER a localized string. Spec §3 requires every calculated figure to be
 * openable ("How this was calculated"), and the client owns all copy — the
 * frontend has a hard i18n mandate. The backend emits codes; the client renders
 * sentences.
 */
export type AssumptionCode =
  | 'horizon_days'
  | 'estimated_incoming_excluded'
  | 'planned_outflows_included'
  | 'no_confirmed_inflow_in_horizon'
  | 'reserve_applied'
  | 'no_reserve_declared'
  | 'overdue_events_clamped_to_today'
  | 'stale_asset_values'
  | 'same_day_outflows_ordered_first';

export interface CalculationAssumption {
  code: AssumptionCode;
  /** Numeric or enum payload — never localized text. */
  value?: number | string;
  relatedIds?: string[];
}

/** An asset reduced to exactly what the forecast needs. */
export interface ForecastLiquidSource {
  assetId: string;
  name: string;
  /** Already valued in the household currency. */
  value: number;
  liquidity: 'usable_now' | 'not_immediately_usable' | 'long_term';
  valueUpdatedAt?: string | null;
}

export interface ForecastCashflowEvent {
  id: string;
  name: string;
  direction: CashflowDirection;
  amount: number;
  expectedDate: IsoDate;
  recurrence: RecurrenceFrequency;
  recurrenceEndDate?: IsoDate | null;
  requirement: CashflowRequirement;
  certainty: CashflowCertainty;
  status: CashflowEventStatus;
  ownerMemberId?: string | null;
  financialGoalId?: string | null;
  debtId?: string | null;
  /** Set by the what-if simulator. Never persisted. */
  isSynthetic?: boolean;
}

export interface ForecastProtectedReserve {
  id: string;
  name: string;
  amount: number;
  status: 'active' | 'archived';
}

export interface ForecastOptions {
  /**
   * §26A.5 — conservative default: `estimated` incoming is DISPLAYED but not
   * banked. Turning this on is an explicit "assume it all arrives".
   */
  includeEstimatedIncoming?: boolean;
  /**
   * `planned` outgoing still spends money, so it moves the balance by default.
   * Tracked separately so obligation coverage can use `required` only.
   */
  includePlannedOutgoing?: boolean;
  /** In-memory only, injected by the what-if simulator. Never persisted. */
  syntheticEvents?: ForecastCashflowEvent[];
  /** Window used for the staleness assumption. */
  staleAfterDays?: number;
}

export interface ForecastInput {
  householdId: string;
  asOfDate: IsoDate;
  horizonDays: number;
  assets: ForecastLiquidSource[];
  cashflowEvents: ForecastCashflowEvent[];
  protectedReserves: ForecastProtectedReserve[];
  options?: ForecastOptions;
}

export interface ForecastOccurrence {
  /** Stable synthetic key `${sourceEventId}@${date}` — NOT a database id. */
  occurrenceKey: string;
  sourceEventId: string;
  occurrenceIndex: number;
  /** True for occurrences the forecast generated rather than read. */
  isVirtual: boolean;
  isSynthetic: boolean;
  date: IsoDate;
  name: string;
  direction: CashflowDirection;
  amount: number;
  requirement: CashflowRequirement;
  certainty: CashflowCertainty;
  status: CashflowEventStatus;
  /** False = shown on the timeline but excluded from the running balance. */
  countedInBalance: boolean;
  exclusionReason?: 'estimated_incoming' | 'planned_outgoing' | 'postponed';
  /** An overdue occurrence pulled onto day 0. */
  wasClampedFromPast: boolean;
  financialGoalId?: string | null;
  debtId?: string | null;
}

export interface ForecastDay {
  date: IsoDate;
  openingBalance: number;
  /** Counted amounts only. */
  incoming: number;
  outgoing: number;
  closingBalance: number;
  /** Includes non-counted occurrences so the timeline can show them. */
  occurrences: ForecastOccurrence[];
}

export interface ForecastTotals {
  upcomingIncomeAmount: number;
  upcomingOutgoingAmount: number;
  requiredOutgoingAmount: number;
  plannedOutgoingAmount: number;
  estimatedIncomingAmountExcluded: number;
}

export interface ForecastResult {
  householdId: string;
  asOfDate: IsoDate;
  horizonDays: number;
  horizonEndDate: IsoDate;
  startingLiquidBalance: number;
  /** One entry per calendar day, inclusive of both ends. */
  days: ForecastDay[];
  /** Event-only, date-sorted — the Upcoming screen's list. */
  timeline: ForecastOccurrence[];
  totals: ForecastTotals;
  /** MAY BE NEGATIVE. The single most important number in the forecast. */
  lowestProjectedBalance: number;
  lowestProjectedBalanceDate: IsoDate;
  endingProjectedBalance: number;
  obligationsCovered: boolean;
  protectedReserveAmount: number;
  reserveProtected: boolean;
  nextSufficientlyCertainInflow: {
    date: IsoDate;
    amount: number;
    sourceEventId: string;
  } | null;
  staleAssetIds: string[];
  usableNowAssetCount: number;
  liveEventCount: number;
  assumptions: CalculationAssumption[];
}

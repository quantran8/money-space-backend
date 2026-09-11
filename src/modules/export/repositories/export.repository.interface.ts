export const EXPORT_REPOSITORY = Symbol('EXPORT_REPOSITORY');

/**
 * Rows come out in the shape the file needs — names already joined, `Decimal`
 * already a number — so the service formats and never queries.
 *
 * Everything is a plain scalar for the same reason the cached payloads are:
 * `Decimal` does not survive `JSON.stringify`, and the JSON export is exactly
 * that.
 */
export interface ExportAssetRow {
  name: string;
  type: string;
  valuationMode: string;
  currentValue: number;
  currency: string;
  liquidity: string;
  status: string;
  /** Market-priced assets only; `null` for a manual one. */
  symbol: string | null;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  valueUpdatedAt: Date | null;
  createdAt: Date;
}

export interface ExportMoneyEventRow {
  eventDate: Date;
  eventType: string;
  direction: string;
  description: string | null;
  categoryName: string | null;
  amount: number;
  feeAmount: number;
  currency: string;
  fromAssetName: string | null;
  toAssetName: string | null;
  status: string;
  createdAt: Date;
}

export interface ExportCashflowEventRow {
  name: string;
  direction: string;
  amount: number;
  expectedDate: Date;
  recurrence: string;
  recurrenceEndDate: Date | null;
  requirement: string | null;
  certainty: string;
  categoryName: string | null;
  status: string;
  note: string | null;
}

export interface ExportGoalRow {
  name: string;
  category: string;
  targetAmount: number;
  targetDate: Date | null;
  priority: string;
  status: string;
  note: string | null;
  createdAt: Date;
}

export interface ExportDebtRow {
  name: string;
  lenderType: string;
  lenderName: string | null;
  originalAmount: number;
  outstandingAmount: number;
  currency: string;
  borrowedAt: Date | null;
  expectedFinalDueDate: Date | null;
  status: string;
  note: string | null;
}

export interface ExportHousehold {
  id: string;
  name: string;
  currency: string;
  createdAt: Date;
}

export interface ExportRepository {
  /** Existence check. The access guard has already authorized the caller. */
  assertHousehold(householdId: string): Promise<ExportHousehold>;

  findAssets(householdId: string): Promise<ExportAssetRow[]>;
  findMoneyEvents(householdId: string): Promise<ExportMoneyEventRow[]>;
  findCashflowEvents(householdId: string): Promise<ExportCashflowEventRow[]>;
  findGoals(householdId: string): Promise<ExportGoalRow[]>;
  findDebts(householdId: string): Promise<ExportDebtRow[]>;
}

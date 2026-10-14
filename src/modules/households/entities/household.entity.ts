export type UpdateFrequency = 'weekly' | 'monthly' | 'manual';

/**
 * Per-household config bag (stored as jsonb on `households.config`). Holds
 * household-scoped settings that don't warrant their own column. Keep it small
 * and additive — every field optional so an empty `{}` is always valid.
 */
export interface HouseholdConfig {
  /** Money-event category CODE auto-selected in the create form. May point at a
   *  system code or one of the household's own custom codes. Undefined = none. */
  defaultEventCategoryId?: string;
  /** Currency used to format household money throughout the client. */
  displayCurrency?: 'VND' | 'USD' | 'EUR';
  /** Home sections in display order. Undefined = the client default. */
  dashboardLayout?: DashboardLayoutItem[];
}

export const DASHBOARD_WIDGET_IDS = [
  'picture',
  'overdue',
  'bankReview',
  'upcoming',
  'spending',
  'goals',
  'moneySources',
] as const;

export interface DashboardLayoutItem {
  id: (typeof DASHBOARD_WIDGET_IDS)[number];
  size: 'half' | 'full';
}

/** Keeps known ids once each; returns undefined when the input is not a list. */
export function normalizeDashboardLayout(
  value: unknown,
): DashboardLayoutItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: DashboardLayoutItem[] = [];
  for (const item of value as Partial<DashboardLayoutItem>[]) {
    const id = item?.id;
    if (!id || !DASHBOARD_WIDGET_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, size: item.size === 'half' ? 'half' : 'full' });
  }
  return out;
}

export interface Household {
  id: string;
  name: string;
  currency: string;
  updateFrequency: UpdateFrequency;
  config: HouseholdConfig;
  createdBy: string;
  createdAt: string;
}

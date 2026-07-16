export type UpdateFrequency = 'weekly' | 'monthly' | 'manual';

/**
 * Per-household config bag (stored as jsonb on `households.config`). Holds
 * household-scoped settings that don't warrant their own column. Keep it small
 * and additive — every field optional so an empty `{}` is always valid.
 */
export interface HouseholdConfig {
  /** Money-event category CODE auto-selected in the create form. May point at a
   *  system code or one of the household's own custom codes. Undefined = none. */
  defaultEventCategoryCode?: string;
  /** Currency used to format household money throughout the client. */
  displayCurrency?: 'VND' | 'USD' | 'EUR';
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

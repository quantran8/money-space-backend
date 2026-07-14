export interface MoneyEventCategory {
  id: string;
  /** NULL for system/global categories shared by every household; a household
   *  id for a household's own custom category. */
  householdId: string | null;
  /** Stable lookup CODE stored on money_events.category. The frontend
   *  translates it via i18n keyed by code, so the label is UI-agnostic. */
  code: string;
  /** Human label (seed/default language). Kept for admin display + fallback;
   *  the localized name comes from i18n keyed by `code`. */
  label: string;
  /** System rows are seeded, shared, and cannot be edited or deleted. */
  isSystem: boolean;
  sortOrder: number;
  /**
   * Whether this category is the household's default (auto-selected in the
   * money-event form). Computed per-household (the pointer lives on
   * `households.config.defaultEventCategoryCode`), NOT stored on the row — a
   * system row is shared, so its default-ness differs per household. At most one
   * category per household has `isDefault: true`.
   */
  isDefault: boolean;
}

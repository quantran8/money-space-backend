export interface CreateMoneyEventCategoryDto {
  /** Stable lookup code (lowercase snake_case). Unique within the household. */
  code: string;
  /** Display label in the seed/default language. */
  label: string;
  /** Ordering hint; lower shows first. Defaults after the last existing row. */
  sortOrder?: number;
}

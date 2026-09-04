export interface CreateMoneyEventCategoryDto {
  /**
   * Stable lookup code (lowercase snake_case), unique within the household.
   * ALWAYS server-generated from `label` — never accepted from the client, so
   * a household never has to invent, see, or retry a slug. Any value sent here
   * is ignored.
   */
  code?: string;
  /** Display label in the seed/default language. */
  label: string;
  /** Glyph key (kebab-case). Validated against the client's known keys; omit
   *  for none. */
  iconKey?: string | null;
  /** Disc fill (hex string, e.g. "#3B82F6"). Omit for the client's default. */
  iconColor?: string | null;
  /** Ordering hint; lower shows first. Defaults after the last existing row. */
  sortOrder?: number;
}

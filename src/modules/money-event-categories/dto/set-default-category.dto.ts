export interface SetDefaultCategoryDto {
  /**
   * The category ID to make the household's default (auto-selected in the
   * money-event form). May be a system or custom category the household can
   * see. `null` clears the default.
   */
  categoryId: string | null;
}

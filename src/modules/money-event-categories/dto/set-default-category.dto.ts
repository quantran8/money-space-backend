export interface SetDefaultCategoryDto {
  /**
   * The category CODE to make the household's default (auto-selected in the
   * money-event form). May be a system or custom code the household can see.
   * `null` clears the default.
   */
  code: string | null;
}

import type { Household } from '../../households/entities/household.entity';
import type { MoneyEventCategory } from '../entities/money-event-category.entity';

export const MONEY_EVENT_CATEGORIES_REPOSITORY = Symbol(
  'MONEY_EVENT_CATEGORIES_REPOSITORY',
);

export interface MoneyEventCategoriesRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(): string;
  /** System (household_id IS NULL) rows + this household's own custom rows. */
  findForHousehold(householdId: string): Promise<MoneyEventCategory[]>;
  /** A single custom row scoped to the household (system rows excluded). */
  findHouseholdCategoryById(
    householdId: string,
    id: string,
  ): Promise<MoneyEventCategory | undefined>;
  /** Does the code already exist in this household's scope (system OR custom)? */
  codeExists(householdId: string, code: string): Promise<boolean>;
  /** Highest sortOrder currently visible to the household (for append). */
  maxSortOrder(householdId: string): Promise<number>;
  insertCategory(category: MoneyEventCategory): Promise<void>;
  updateCategory(id: string, category: MoneyEventCategory): Promise<void>;
  deleteCategory(id: string): Promise<void>;
}

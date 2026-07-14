import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MoneyEventCategory } from './entities/money-event-category.entity';
import type { CreateMoneyEventCategoryDto } from './dto/create-money-event-category.dto';
import type { UpdateMoneyEventCategoryDto } from './dto/update-money-event-category.dto';
import { MONEY_EVENT_CATEGORIES_REPOSITORY } from './repositories/money-event-categories.repository.interface';
import type { MoneyEventCategoriesRepository } from './repositories/money-event-categories.repository.interface';

// Lowercase snake_case, matching the seeded system codes. Keeps codes usable as
// i18n keys (`options.eventCategory.<code>`) on the client.
const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

@Injectable()
export class MoneyEventCategoriesService {
  constructor(
    @Inject(MONEY_EVENT_CATEGORIES_REPOSITORY)
    private readonly repository: MoneyEventCategoriesRepository,
  ) {}

  async listCategories(householdId: string) {
    const household = await this.repository.assertHousehold(householdId);
    const rows = await this.repository.findForHousehold(householdId);
    // Overlay per-household default-ness: the pointer lives on the household's
    // config, not on the (possibly shared) category rows.
    const defaultCode = household.config.defaultEventCategoryCode;
    const items = rows.map((category) => ({
      ...category,
      isDefault: !!defaultCode && category.code === defaultCode,
    }));
    return { householdId, items, total: items.length };
  }

  /**
   * Set (or clear) the household's **default** money-event category — the code
   * auto-selected in the create form. Exactly one default per household; setting
   * a new one replaces the previous (the pointer is a single code on the
   * household's config). The target may be a **system OR custom** category the
   * household can see; a code it can't see (or a deleted one) is rejected. Pass
   * `code = null` to clear the default. Returns the updated category list.
   */
  async setDefaultCategory(householdId: string, code: string | null) {
    await this.repository.assertHousehold(householdId);
    if (code !== null) {
      const normalized = code.trim().toLowerCase();
      if (!normalized) {
        throw new BadRequestException('A default category code is required.');
      }
      const category = await this.repository.findCategoryByCode(
        householdId,
        normalized,
      );
      if (!category) {
        throw new NotFoundException(
          `Category "${normalized}" was not found for this household.`,
        );
      }
      await this.repository.setDefaultCategoryCode(householdId, normalized);
    } else {
      await this.repository.setDefaultCategoryCode(householdId, null);
    }
    return this.listCategories(householdId);
  }

  async createCategory(
    householdId: string,
    payload: CreateMoneyEventCategoryDto,
  ): Promise<MoneyEventCategory> {
    await this.repository.assertHousehold(householdId);

    const code = payload.code?.trim().toLowerCase();
    const label = payload.label?.trim();
    if (!code || !CODE_PATTERN.test(code)) {
      throw new BadRequestException(
        'Category code must be lowercase letters, digits or underscores and start with a letter.',
      );
    }
    if (!label) {
      throw new BadRequestException('Category label is required.');
    }
    // Code is unique per scope; a household can't shadow a system code either
    // (the DB partial-unique indexes enforce this, but we surface a clean 409).
    if (await this.repository.codeExists(householdId, code)) {
      throw new ConflictException(`Category code "${code}" already exists.`);
    }

    const sortOrder =
      payload.sortOrder ??
      (await this.repository.maxSortOrder(householdId)) + 10;

    const category: MoneyEventCategory = {
      id: this.repository.createId(),
      householdId,
      code,
      label,
      isSystem: false,
      sortOrder,
      // A freshly created category is never the default until explicitly set.
      isDefault: false,
    };

    await this.repository.insertCategory(category);
    return category;
  }

  async updateCategory(
    householdId: string,
    id: string,
    payload: UpdateMoneyEventCategoryDto,
  ): Promise<MoneyEventCategory> {
    const existing = await this.ensureCustomCategory(householdId, id);

    const label = payload.label?.trim();
    if (payload.label !== undefined && !label) {
      throw new BadRequestException('Category label cannot be empty.');
    }

    const next: MoneyEventCategory = {
      ...existing,
      label: label ?? existing.label,
      sortOrder: payload.sortOrder ?? existing.sortOrder,
    };

    await this.repository.updateCategory(id, next);
    return next;
  }

  async deleteCategory(householdId: string, id: string) {
    const existing = await this.ensureCustomCategory(householdId, id);
    await this.repository.deleteCategory(id);
    // If the deleted category was the household's default, clear the dangling
    // pointer so the form doesn't try to auto-select a code that no longer
    // exists. (assertHousehold already ran inside ensureCustomCategory.)
    const household = await this.repository.assertHousehold(householdId);
    if (household.config.defaultEventCategoryCode === existing.code) {
      await this.repository.setDefaultCategoryCode(householdId, null);
    }
    return { deleted: true, categoryId: id };
  }

  // Loads a household-owned category, rejecting system rows (they're shared and
  // read-only) and missing ids. System rows never match findHouseholdCategoryById
  // because it's scoped to the household's own householdId.
  private async ensureCustomCategory(
    householdId: string,
    id: string,
  ): Promise<MoneyEventCategory> {
    await this.repository.assertHousehold(householdId);
    const category = await this.repository.findHouseholdCategoryById(
      householdId,
      id,
    );
    if (!category) {
      throw new NotFoundException(
        `Category "${id}" was not found or is a system category that cannot be modified.`,
      );
    }
    return category;
  }
}

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
    await this.repository.assertHousehold(householdId);
    const items = await this.repository.findForHousehold(householdId);
    return { householdId, items, total: items.length };
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
    await this.ensureCustomCategory(householdId, id);
    await this.repository.deleteCategory(id);
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

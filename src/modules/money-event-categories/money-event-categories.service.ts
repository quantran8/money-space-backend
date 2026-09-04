import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MoneyEventCategory } from './entities/money-event-category.entity';
import type { CreateMoneyEventCategoryDto } from './dto/create-money-event-category.dto';
import type { UpdateMoneyEventCategoryDto } from './dto/update-money-event-category.dto';
import { MONEY_EVENT_CATEGORIES_REPOSITORY } from './repositories/money-event-categories.repository.interface';
import type { MoneyEventCategoriesRepository } from './repositories/money-event-categories.repository.interface';

// Glyph keys are kebab-case lucide icon names. Shape-checked only: the CLIENT
// owns the key → component map and falls back on anything it does not know, so
// pinning the valid set here would mean a backend release every time the client
// adds a glyph.
const ICON_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
const ICON_KEY_MAX = 64;

// 3- or 6-digit hex, with or without alpha (#RGB, #RRGGBB, #RRGGBBAA). The
// disc's fill is a free colour choice, not a palette off the design tokens —
// so this only checks it IS a colour, not which one.
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// Empty string and null both mean "no custom fill". Normalizing them to null
// keeps one representation in the column, so the client's default has one
// case to check.
function normalizeIconColor(iconColor: string | null | undefined): string | null {
  if (iconColor === undefined || iconColor === null) return null;
  const trimmed = iconColor.trim();
  if (!trimmed) return null;
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    throw new BadRequestException(
      'Category icon color must be a hex color (e.g. "#3B82F6").',
    );
  }
  return trimmed.toLowerCase();
}

// Vietnamese diacritics -> ASCII, everything else collapsed to underscores.
// `đ`/`Đ` survive NFD decomposition (it isn't a combining-mark form of `d`), so
// they get an explicit pass before the generic strip.
function slugify(label: string): string {
  const ascii = label
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const slug = ascii
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'category';
}

// Empty string and null both mean "no glyph". Normalizing them to null keeps one
// representation in the column, so the client's fallback has one case to check.
function normalizeIconKey(iconKey: string | null | undefined): string | null {
  if (iconKey === undefined || iconKey === null) return null;
  const trimmed = iconKey.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.length > ICON_KEY_MAX || !ICON_KEY_PATTERN.test(trimmed)) {
    throw new BadRequestException(
      'Category icon key must be kebab-case letters and digits (a lucide icon name).',
    );
  }

  return trimmed;
}

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
    const defaultId = household.config.defaultEventCategoryId;
    const items = rows
      .map((category) => ({
        ...category,
        isDefault: !!defaultId && category.id === defaultId,
      }))
      // The default leads the list wherever it is rendered — a picker, the
      // settings card — so the row the household actually reaches for is not
      // buried mid-alphabet. Everything after it keeps the repository's
      // sortOrder/label order.
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
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
  async setDefaultCategory(householdId: string, categoryId: string | null) {
    await this.repository.assertHousehold(householdId);
    if (categoryId !== null) {
      const normalized = categoryId.trim();
      if (!normalized) {
        throw new BadRequestException('A default category id is required.');
      }
      const category = await this.repository.findVisibleCategoryById(
        householdId,
        normalized,
      );
      if (!category) {
        throw new NotFoundException(
          `Category "${normalized}" was not found for this household.`,
        );
      }
      await this.repository.setDefaultCategoryId(householdId, normalized);
    } else {
      await this.repository.setDefaultCategoryId(householdId, null);
    }
    return this.listCategories(householdId);
  }

  async createCategory(
    householdId: string,
    payload: CreateMoneyEventCategoryDto,
  ): Promise<MoneyEventCategory> {
    await this.repository.assertHousehold(householdId);

    const label = payload.label?.trim();
    if (!label) {
      throw new BadRequestException('Category label is required.');
    }

    // The code is ALWAYS derived from the label, never taken from the client —
    // a household should never have to invent, see, or retry a lowercase
    // snake_case slug by hand. Collisions (two categories sharing a slug, or a
    // slug landing on a seeded system code) are resolved by appending "_2",
    // "_3", ... rather than surfacing a 409 the label field gave no way to
    // predict.
    const base = slugify(label);
    let code = base;
    let suffix = 2;
    while (await this.repository.codeExists(householdId, code)) {
      code = `${base}_${suffix}`;
      suffix += 1;
    }

    const sortOrder =
      payload.sortOrder ??
      (await this.repository.maxSortOrder(householdId)) + 10;

    const category: MoneyEventCategory = {
      id: this.repository.createId(),
      householdId,
      code,
      label,
      iconKey: normalizeIconKey(payload.iconKey),
      iconColor: normalizeIconColor(payload.iconColor),
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
      // Absent leaves the glyph alone; an explicit null clears it.
      iconKey:
        payload.iconKey === undefined
          ? existing.iconKey
          : normalizeIconKey(payload.iconKey),
      iconColor:
        payload.iconColor === undefined
          ? existing.iconColor
          : normalizeIconColor(payload.iconColor),
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
    if (household.config.defaultEventCategoryId === existing.id) {
      await this.repository.setDefaultCategoryId(householdId, null);
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

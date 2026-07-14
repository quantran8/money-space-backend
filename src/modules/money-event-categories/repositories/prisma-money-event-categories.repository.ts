import { Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../../../common/utils/uuid';
import {
  mapHousehold,
  mapMoneyEventCategory,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Household } from '../../households/entities/household.entity';
import { MoneyEventCategory } from '../entities/money-event-category.entity';
import { MoneyEventCategoriesRepository } from './money-event-categories.repository.interface';

@Injectable()
export class PrismaMoneyEventCategoriesRepository
  extends PrismaRepository
  implements MoneyEventCategoriesRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(): string {
    return uuidv7();
  }

  async assertHousehold(householdId: string): Promise<Household> {
    const household = await this.prisma.household.findFirst({
      where: { id: householdId, deletedAt: null },
    });

    if (!household) {
      throw new NotFoundException(`Household "${householdId}" was not found`);
    }

    return mapHousehold(household);
  }

  async findForHousehold(householdId: string): Promise<MoneyEventCategory[]> {
    const rows = await this.prisma.moneyEventCategory.findMany({
      // Global (system) rows have householdId NULL; a household also sees its
      // own custom rows. Both filtered to live (deletedAt: null).
      where: {
        deletedAt: null,
        OR: [{ householdId: null }, { householdId }],
      },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });

    return rows.map(mapMoneyEventCategory);
  }

  async findHouseholdCategoryById(
    householdId: string,
    id: string,
  ): Promise<MoneyEventCategory | undefined> {
    const row = await this.prisma.moneyEventCategory.findFirst({
      // Scoped to the household's OWN rows — system rows (householdId NULL) are
      // deliberately excluded so they can't be edited/deleted through here.
      where: { id, householdId, deletedAt: null },
    });

    return row ? mapMoneyEventCategory(row) : undefined;
  }

  async codeExists(householdId: string, code: string): Promise<boolean> {
    const row = await this.prisma.moneyEventCategory.findFirst({
      where: {
        code,
        deletedAt: null,
        OR: [{ householdId: null }, { householdId }],
      },
      select: { id: true },
    });

    return !!row;
  }

  async maxSortOrder(householdId: string): Promise<number> {
    const row = await this.prisma.moneyEventCategory.findFirst({
      where: {
        deletedAt: null,
        OR: [{ householdId: null }, { householdId }],
      },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    return row?.sortOrder ?? 0;
  }

  async insertCategory(category: MoneyEventCategory): Promise<void> {
    await this.prisma.moneyEventCategory.create({
      data: {
        id: category.id,
        householdId: category.householdId,
        code: category.code,
        label: category.label,
        isSystem: category.isSystem,
        sortOrder: category.sortOrder,
      },
    });
  }

  async updateCategory(
    id: string,
    category: MoneyEventCategory,
  ): Promise<void> {
    await this.prisma.moneyEventCategory.update({
      where: { id },
      data: {
        label: category.label,
        sortOrder: category.sortOrder,
      },
    });
  }

  async deleteCategory(id: string): Promise<void> {
    await this.prisma.moneyEventCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}

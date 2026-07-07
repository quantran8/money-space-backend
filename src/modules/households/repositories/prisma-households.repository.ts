import { Injectable, NotFoundException } from '@nestjs/common';
import { mapHousehold } from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Household } from '../entities/household.entity';
import { HouseholdsRepository } from './households.repository.interface';

@Injectable()
export class PrismaHouseholdsRepository
  extends PrismaRepository
  implements HouseholdsRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
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

  async getHouseholds(): Promise<Household[]> {
    const households = await this.prisma.household.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    return households.map((household) => mapHousehold(household));
  }

  async countMembers(householdId?: string): Promise<number> {
    return this.prisma.householdMember.count({
      where: { householdId },
    });
  }
}

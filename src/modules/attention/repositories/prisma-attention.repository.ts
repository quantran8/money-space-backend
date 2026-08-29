import { Injectable, NotFoundException } from '@nestjs/common';
import { mapHousehold } from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Household } from '../../households/entities/household.entity';
import type { AttentionRepository } from './attention.repository.interface';

@Injectable()
export class PrismaAttentionRepository
  extends PrismaRepository
  implements AttentionRepository
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
}

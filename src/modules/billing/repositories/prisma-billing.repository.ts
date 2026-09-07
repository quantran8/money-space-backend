import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import type { SubscriptionRow } from '../domain/entitlement';
import type { EntitlementUsage } from '../entities/entitlement.entity';
import type { BillingRepository } from './billing.repository.interface';

@Injectable()
export class PrismaBillingRepository
  extends PrismaRepository
  implements BillingRepository
{
  constructor(prismaService: PrismaService) {
    super(prismaService);
  }

  async findSubscription(householdId: string): Promise<SubscriptionRow | null> {
    const row = await this.prisma.householdSubscription.findUnique({
      where: { householdId },
      select: {
        tier: true,
        status: true,
        currentPeriodEnd: true,
        source: true,
        trialStartedAt: true,
        trialEndsAt: true,
      },
    });

    return row ?? null;
  }

  async countUsage(
    householdId: string,
  ): Promise<Omit<EntitlementUsage, 'whatIfThisMonth'>> {
    const [goals, marketPricedAssets] = await Promise.all([
      // Only ACTIVE goals occupy a slot. Counting completed ones would mean a
      // household that reached two goals could never start a third — punishing
      // them for succeeding.
      this.prisma.financialGoal.count({
        where: { householdId, status: 'active', deletedAt: null },
      }),
      this.prisma.asset.count({
        where: {
          householdId,
          valuationMode: 'market_priced',
          status: 'active',
          deletedAt: null,
        },
      }),
    ]);

    return { goals, marketPricedAssets };
  }
}

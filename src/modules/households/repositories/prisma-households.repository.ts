import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mapHousehold } from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Household } from '../entities/household.entity';
import {
  CreateHouseholdInput,
  HouseholdsRepository,
} from './households.repository.interface';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

  async getHouseholdsForUser(userId: string): Promise<Household[]> {
    const households = await this.prisma.household.findMany({
      where: {
        deletedAt: null,
        householdMembers: { some: { userId } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return households.map((household) => mapHousehold(household));
  }

  async createHousehold(input: CreateHouseholdInput): Promise<Household> {
    const householdId = randomUUID();
    const now = new Date();

    const household = await this.runInTransaction(async (tx) => {
      // Ensure a profile row exists for the owner (auth user).
      await tx.profile.upsert({
        where: { id: input.ownerId },
        update: {},
        create: {
          id: input.ownerId,
          email: input.ownerEmail,
          fullName: input.ownerName,
          displayName: input.ownerName,
        } as any,
      });

      const created = await tx.household.create({
        data: {
          id: householdId,
          name: input.name,
          currency: input.currency,
          updateFrequency: input.updateFrequency,
          createdById: input.ownerId,
        } as any,
      });

      // Creator becomes owner + admin.
      await tx.householdMember.create({
        data: {
          id: randomUUID(),
          householdId,
          userId: input.ownerId,
          role: 'owner',
          permissionLevel: 'admin',
          joinedAt: now,
        } as any,
      });

      if (input.inviteEmail) {
        await tx.householdInvite.create({
          data: {
            id: randomUUID(),
            householdId,
            invitedById: input.ownerId,
            inviteeEmail: input.inviteEmail,
            token: randomUUID(),
            status: 'pending',
            defaultRole: 'partner',
            defaultPermissionLevel: 'view_detail',
            expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          } as any,
        });
      }

      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          householdId,
          actorId: input.ownerId,
          action: 'household.created',
          entityType: 'household',
          entityId: householdId,
          metadata: { invitedPartner: Boolean(input.inviteEmail) },
        } as any,
      });

      return created;
    });

    return mapHousehold(household);
  }

  async countMembers(householdId?: string): Promise<number> {
    return this.prisma.householdMember.count({
      where: { householdId },
    });
  }
}

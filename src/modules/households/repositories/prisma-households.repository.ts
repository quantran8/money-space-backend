import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { uuidv7 } from '../../../common/utils/uuid';
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
    const householdId = uuidv7();
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
          id: uuidv7(),
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
            id: uuidv7(),
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
          id: uuidv7(),
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

  /**
   * Soft-delete the household and every membership in it.
   *
   * Memberships go too: `HouseholdAccessGuard` resolves access from a live
   * membership row, so leaving them behind would keep the household reachable
   * through every household-scoped route after it was "deleted".
   *
   * The audit row is written BEFORE the soft-deletes and deliberately survives
   * them — `audit_logs` is append-only and never soft-deleted, so the deletion
   * stays on the record even though what it refers to is gone.
   */
  async deleteHousehold(householdId: string, actorId: string): Promise<void> {
    await this.runInTransaction(async (tx) => {
      const now = new Date();

      await tx.auditLog.create({
        data: {
          id: uuidv7(),
          householdId,
          actorId,
          action: 'household.deleted',
          entityType: 'household',
          entityId: householdId,
          metadata: {},
        } as never,
      });

      await tx.householdMember.updateMany({
        where: { householdId, deletedAt: null },
        data: { deletedAt: now },
      });

      await tx.household.update({
        where: { id: householdId },
        data: { deletedAt: now },
      });
    });
  }

  /**
   * Hand the lifecycle safeguard to another member.
   *
   * Without this, a creator who stops using the app leaves the household
   * unable to invite or remove anyone, permanently — the one real hole in
   * anchoring the safeguard on `created_by`. The target must be a LIVE member,
   * otherwise the transfer would recreate the same lock-out it exists to
   * prevent.
   */
  async transferSteward(
    householdId: string,
    toUserId: string,
    actorId: string,
  ): Promise<Household> {
    return this.runInTransaction(async (tx) => {
      const member = await tx.householdMember.findFirst({
        where: { householdId, userId: toUserId, deletedAt: null },
        select: { id: true },
      });
      if (!member) {
        throw new NotFoundException(
          'That member is not part of this household',
        );
      }

      const updated = await tx.household.update({
        where: { id: householdId },
        data: { createdById: toUserId } as never,
      });

      await tx.auditLog.create({
        data: {
          id: uuidv7(),
          householdId,
          actorId,
          action: 'household.steward_transferred',
          entityType: 'household',
          entityId: householdId,
          metadata: { toUserId },
        } as never,
      });

      return mapHousehold(updated);
    });
  }

  async countMembers(householdId?: string): Promise<number> {
    return this.prisma.householdMember.count({
      where: { householdId },
    });
  }

  async setDisplayCurrency(
    householdId: string,
    currency: string,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE households
      SET config = COALESCE(config, '{}'::jsonb)
        || jsonb_build_object('displayCurrency', ${currency}::text)
      WHERE id = ${householdId}::uuid
        AND deleted_at IS NULL
    `;
  }
}

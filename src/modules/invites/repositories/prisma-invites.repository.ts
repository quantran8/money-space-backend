import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { mapHousehold } from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { uuidv7 } from '../../../common/utils/uuid';
import { Household } from '../../households/entities/household.entity';
import type { HouseholdInvite } from '../entities/invite.entity';
import type {
  AcceptInviteResult,
  InvitesRepository,
} from './invites.repository.interface';

@Injectable()
export class PrismaInvitesRepository
  extends PrismaRepository
  implements InvitesRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(_prefix: string): string {
    return uuidv7();
  }

  /**
   * `randomUUID` is crypto-strong (122 bits). Deliberately NOT uuidv7 like our
   * row ids: v7 embeds a timestamp, so a token minted from it would leak when
   * it was created and be partially guessable from a known sibling.
   */
  createToken(): string {
    return randomUUID();
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

  async findInvitesByHousehold(
    householdId: string,
  ): Promise<HouseholdInvite[]> {
    const rows = await this.prisma.householdInvite.findMany({
      where: { householdId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toEntity(row));
  }

  async findInviteById(
    householdId: string,
    inviteId: string,
  ): Promise<HouseholdInvite | undefined> {
    const row = await this.prisma.householdInvite.findFirst({
      where: { id: inviteId, householdId },
    });
    return row ? this.toEntity(row) : undefined;
  }

  async findInviteByToken(token: string): Promise<HouseholdInvite | undefined> {
    const row = await this.prisma.householdInvite.findFirst({
      where: { token },
    });
    return row ? this.toEntity(row) : undefined;
  }

  async findInviteContext(inviteId: string) {
    const row = await this.prisma.householdInvite.findFirst({
      where: { id: inviteId },
      select: {
        household: { select: { name: true } },
        invitedBy: { select: { fullName: true, displayName: true } },
      },
    });
    if (!row) {
      return undefined;
    }
    return {
      householdName: row.household.name,
      invitedByName:
        row.invitedBy?.displayName ?? row.invitedBy?.fullName ?? null,
    };
  }

  async insertInvite(invite: HouseholdInvite): Promise<void> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO household_invites
        (id, household_id, invited_by, invitee_email, invitee_phone, token,
         status, default_role, default_permission_level, expires_at, updated_at)
      SELECT
        ${invite.id}::uuid,
        h.id,
        ${invite.invitedById}::uuid,
        ${invite.inviteeEmail},
        ${invite.inviteePhone},
        ${invite.token},
        ${invite.status}::"InviteStatus",
        ${invite.defaultRole}::"HouseholdRole",
        ${invite.defaultPermissionLevel}::"PermissionLevel",
        ${new Date(invite.expiresAt)}::timestamptz,
        now()
      FROM households h
      WHERE h.id = ${invite.householdId}::uuid
        AND h.deleted_at IS NULL
    `;

    if (inserted === 0) {
      throw new NotFoundException(
        `Household "${invite.householdId}" was not found`,
      );
    }
  }

  async revokeInvite(inviteId: string): Promise<void> {
    await this.prisma.householdInvite.updateMany({
      // Only a still-pending invite can be revoked: revoking one that was
      // already accepted would misrepresent history — the person did join.
      where: { id: inviteId, status: 'pending' },
      data: { status: 'cancelled' },
    });
  }

  async acceptInvite(
    invite: HouseholdInvite,
    user: { id: string; email: string | null; fullName: string | null },
  ): Promise<AcceptInviteResult> {
    return this.runInTransaction(async (tx) => {
      // The invitee may be signing in for the very first time, so their profile
      // row may not exist yet. Upsert rather than assume.
      await tx.profile.upsert({
        where: { id: user.id },
        update: {},
        create: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          displayName: user.fullName,
        } as never,
      });

      // Re-check membership INSIDE the transaction. Two taps on the same link
      // can race; `household_members_unique` would then raise a constraint
      // error rather than the friendly no-op the caller expects.
      const existing = await tx.householdMember.findFirst({
        where: {
          householdId: invite.householdId,
          userId: user.id,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (existing) {
        // Still consume the token — the invite did its job.
        await tx.householdInvite.updateMany({
          where: { id: invite.id, status: 'pending' },
          data: {
            status: 'accepted',
            acceptedById: user.id,
            acceptedAt: new Date(),
          },
        });
        return {
          householdId: invite.householdId,
          memberId: existing.id,
          alreadyMember: true,
        };
      }

      const memberId = uuidv7();
      await tx.householdMember.create({
        data: {
          id: memberId,
          householdId: invite.householdId,
          userId: user.id,
          role: invite.defaultRole,
          // NULL is meaningful: it derives permission from the role, so a later
          // change to the role's default reaches this member too.
          permissionLevel: invite.defaultPermissionLevel,
          invitedById: invite.invitedById,
          joinedAt: new Date(),
        } as never,
      });

      // Guarded on `status = 'pending'` so a concurrent accept can only win
      // once; the loser sees zero rows updated and its membership insert would
      // already have failed on the unique constraint.
      await tx.householdInvite.updateMany({
        where: { id: invite.id, status: 'pending' },
        data: {
          status: 'accepted',
          acceptedById: user.id,
          acceptedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          id: uuidv7(),
          householdId: invite.householdId,
          actorId: user.id,
          action: 'household.member_joined',
          entityType: 'household_member',
          entityId: memberId,
          metadata: { inviteId: invite.id, role: invite.defaultRole },
        } as never,
      });

      return {
        householdId: invite.householdId,
        memberId,
        alreadyMember: false,
      };
    });
  }

  private toEntity(row: Record<string, any>): HouseholdInvite {
    return {
      id: row.id,
      householdId: row.householdId,
      invitedById: row.invitedById,
      inviteeEmail: row.inviteeEmail ?? null,
      inviteePhone: row.inviteePhone ?? null,
      token: row.token,
      status: row.status,
      defaultRole: row.defaultRole,
      defaultPermissionLevel: row.defaultPermissionLevel ?? null,
      expiresAt: new Date(row.expiresAt).toISOString(),
      acceptedById: row.acceptedById ?? null,
      acceptedAt: row.acceptedAt
        ? new Date(row.acceptedAt).toISOString()
        : null,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}

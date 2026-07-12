import { Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../../../common/utils/uuid';
import {
  mapHousehold,
  mapMember,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Household } from '../../households/entities/household.entity';
import { HouseholdMember } from '../entities/member.entity';
import { MembersRepository } from './members.repository.interface';

@Injectable()
export class PrismaMembersRepository
  extends PrismaRepository
  implements MembersRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(_prefix: string): string {
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

  async findMembersByHousehold(
    householdId: string,
  ): Promise<HouseholdMember[]> {
    const members = await this.prisma.householdMember.findMany({
      where: { householdId, deletedAt: null },
      include: { user: true },
      orderBy: { joinedAt: 'asc' },
    });

    return members.map((member) =>
      mapMember(member, member.user, this.makeInitials),
    );
  }

  async findMemberById(
    householdId: string,
    memberId: string,
  ): Promise<HouseholdMember | undefined> {
    const member = await this.prisma.householdMember.findFirst({
      where: { id: memberId, householdId, deletedAt: null },
      include: { user: true },
    });

    return member
      ? mapMember(member, member.user, this.makeInitials)
      : undefined;
  }

  async insertMember(member: HouseholdMember): Promise<void> {
    // The profile upsert and the household-member insert must land together, so
    // run them in one transaction. We assert the household first: the
    // `household_members` insert has an FK to the household, so a missing
    // household would otherwise surface as a 500 FK error instead of the
    // expected 404. Statements run sequentially — they share the transaction's
    // single connection, so no `Promise.all` on the shared `tx`.
    await this.assertHousehold(member.householdId);
    await this.runInTransaction(async (tx) => {
      await tx.profile.upsert({
        where: { id: member.profileId },
        update: {
          email: member.email,
          displayName: member.name,
          fullName: member.name,
        } as any,
        create: {
          id: member.profileId,
          email: member.email,
          displayName: member.name,
          fullName: member.name,
        } as any,
      });

      await tx.householdMember.create({
        data: {
          id: member.id,
          householdId: member.householdId,
          userId: member.profileId,
          role: member.role,
          permissionLevel: member.permission,
          status: member.status ?? 'active',
          joinedAt: new Date(member.joinedAt),
        } as any,
      });
    });
  }

  async updateMember(memberId: string, member: HouseholdMember): Promise<void> {
    // The profile update and the household-member update must land together, so
    // run them in one transaction, sequentially (they share the transaction's
    // single connection).
    await this.runInTransaction(async (tx) => {
      await tx.profile.updateMany({
        where: { id: member.profileId },
        data: {
          email: member.email,
          displayName: member.name,
          fullName: member.name,
        } as any,
      });
      await tx.householdMember.update({
        where: { id: memberId },
        data: {
          role: member.role,
          permissionLevel: member.permission,
          status: member.status ?? undefined,
          joinedAt: new Date(member.joinedAt),
        } as any,
      });
    });
  }

  async deleteMember(memberId: string): Promise<void> {
    // Soft-delete to keep FK references (audit, owned assets/debts) intact.
    await this.prisma.householdMember.updateMany({
      where: { id: memberId, deletedAt: null },
      data: { deletedAt: new Date() } as any,
    });
  }
}

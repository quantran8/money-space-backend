import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
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

  async findMembersByHousehold(householdId: string): Promise<HouseholdMember[]> {
    const members = await this.prisma.householdMember.findMany({
      where: { householdId },
      include: { user: true },
      orderBy: { joinedAt: 'asc' },
    });

    return members.map((member) => mapMember(member, member.user, this.makeInitials));
  }

  async findMemberById(
    householdId: string,
    memberId: string,
  ): Promise<HouseholdMember | undefined> {
    const member = await this.prisma.householdMember.findFirst({
      where: { id: memberId, householdId },
      include: { user: true },
    });

    return member ? mapMember(member, member.user, this.makeInitials) : undefined;
  }

  async insertMember(member: HouseholdMember): Promise<void> {
    await this.prisma.profile.upsert({
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

    await this.prisma.householdMember.create({
      data: {
        id: member.id,
        householdId: member.householdId,
        userId: member.profileId,
        role: member.role,
        permissionLevel: member.permission,
        joinedAt: new Date(member.joinedAt),
      } as any,
    });
  }

  async updateMember(memberId: string, member: HouseholdMember): Promise<void> {
    await this.prisma.profile.updateMany({
      where: { id: member.profileId },
      data: {
        email: member.email,
        displayName: member.name,
        fullName: member.name,
      } as any,
    });

    await this.prisma.householdMember.update({
      where: { id: memberId },
      data: {
        role: member.role,
        permissionLevel: member.permission,
        joinedAt: new Date(member.joinedAt),
      } as any,
    });
  }

  async deleteMember(memberId: string): Promise<void> {
    await this.prisma.householdMember.delete({
      where: { id: memberId },
    });
  }
}

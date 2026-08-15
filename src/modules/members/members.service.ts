import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { uuidv7 } from '../../common/utils/uuid';
import { HouseholdMember } from './entities/member.entity';
import { makeInitials } from '../../common/utils/money-space.utils';
import type { CreateMemberDto } from './dto/create-member.dto';
import type { UpdateMemberDto } from './dto/update-member.dto';
import { MEMBERS_REPOSITORY } from './repositories/members.repository.interface';
import type { MembersRepository } from './repositories/members.repository.interface';

@Injectable()
export class MembersService {
  constructor(
    @Inject(MEMBERS_REPOSITORY)
    private readonly membersRepository: MembersRepository,
  ) {}

  async listMembers(householdId: string) {
    const household = await this.membersRepository.assertHousehold(householdId);
    const items =
      await this.membersRepository.findMembersByHousehold(householdId);
    return {
      household,
      items,
      total: items.length,
    };
  }

  async getMember(householdId: string, memberId: string) {
    return this.ensureMember(householdId, memberId);
  }

  async createMember(householdId: string, payload: CreateMemberDto) {
    // `insertMember` asserts the household exists (it must, so the FK-backed
    // `household_members` insert surfaces a 404 rather than a 500 FK error) and
    // runs that check concurrently with the profile upsert, so we don't assert
    // the household a second time here.
    const member: HouseholdMember = {
      id: this.membersRepository.createId('member'),
      profileId: payload.profileId ?? uuidv7(),
      householdId,
      name: payload.name.trim(),
      email: payload.email.trim(),
      initials:
        payload.initials?.trim() || makeInitials(payload.name || payload.email),
      role: payload.role,
      joinedAt: payload.joinedAt ?? new Date().toISOString(),
      lastActive: payload.lastActive ?? 'Vừa mời',
      status: payload.status ?? 'invited',
    };

    await this.membersRepository.insertMember(member);
    return member;
  }

  async updateMember(
    householdId: string,
    memberId: string,
    payload: UpdateMemberDto,
  ) {
    const member = await this.ensureMember(householdId, memberId);
    const nextRole = payload.role ?? member.role;
    const next: HouseholdMember = {
      ...member,
      ...payload,
      id: member.id,
      householdId: member.householdId,
      profileId: payload.profileId ?? member.profileId,
      name: payload.name?.trim() ?? member.name,
      email: payload.email?.trim() ?? member.email,
      initials:
        payload.initials?.trim() ||
        member.initials ||
        makeInitials(payload.name ?? payload.email ?? member.email),
      role: nextRole,
    };

    await this.membersRepository.updateMember(memberId, next);
    return next;
  }

  async deleteMember(householdId: string, memberId: string) {
    // Anchored on `households.created_by`, not on a role column.
    //
    // This is structural, not cosmetic: the creator is the only member who can
    // invite, remove, or delete, and the guard resolves that from a LIVE
    // membership row. Removing the creator's row would therefore lock the
    // household permanently — nobody could invite anyone, and nobody could
    // remove the ghost. Refusing here is what makes that unreachable.
    // Handing the role over is `POST /households/:householdId/transfer-steward`.
    const [household, member] = await Promise.all([
      this.membersRepository.assertHousehold(householdId),
      this.ensureMember(householdId, memberId),
    ]);
    if (member.profileId === household.createdBy) {
      throw new BadRequestException(
        'The member who created this household cannot be removed. Transfer that first.',
      );
    }

    await this.membersRepository.deleteMember(memberId);
    return {
      deleted: true,
      memberId,
    };
  }

  private async ensureMember(householdId: string, memberId: string) {
    // Querying by { id, memberId, householdId } already returns undefined when
    // the member (or its household) is absent, so a separate assertHousehold
    // before it would be a wasted round-trip.
    const member = await this.membersRepository.findMemberById(
      householdId,
      memberId,
    );
    if (!member) {
      throw new NotFoundException(`Member "${memberId}" was not found`);
    }
    return member;
  }
}

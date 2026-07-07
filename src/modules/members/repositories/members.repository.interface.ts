import type { Household } from '../../households/entities/household.entity';
import type { HouseholdMember } from '../entities/member.entity';

export const MEMBERS_REPOSITORY = Symbol('MEMBERS_REPOSITORY');

export interface MembersRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findMembersByHousehold(householdId: string): Promise<HouseholdMember[]>;
  findMemberById(householdId: string, memberId: string): Promise<HouseholdMember | undefined>;
  insertMember(member: HouseholdMember): Promise<void>;
  updateMember(memberId: string, member: HouseholdMember): Promise<void>;
  deleteMember(memberId: string): Promise<void>;
}

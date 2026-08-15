import type { HouseholdRole } from '../entities/member.entity';

export interface CreateMemberDto {
  profileId?: string;
  name: string;
  email: string;
  initials?: string;
  role: HouseholdRole;
  joinedAt?: string;
  lastActive?: string;
  status?: 'active' | 'invited';
}

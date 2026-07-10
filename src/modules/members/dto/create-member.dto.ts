import type { HouseholdRole, PermissionLevel } from '../entities/member.entity';

export interface CreateMemberDto {
  profileId?: string;
  name: string;
  email: string;
  initials?: string;
  role: HouseholdRole;
  permission?: PermissionLevel;
  joinedAt?: string;
  lastActive?: string;
  status?: 'active' | 'invited';
}

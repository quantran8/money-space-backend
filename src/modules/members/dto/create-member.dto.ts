
export interface CreateMemberDto {
  profileId?: string;
  name: string;
  email: string;
  initials?: string;
  joinedAt?: string;
  lastActive?: string;
  status?: 'active' | 'invited';
}

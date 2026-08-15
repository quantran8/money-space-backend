export type HouseholdRole = 'owner' | 'partner' | 'viewer';

export interface HouseholdMember {
  id: string;
  profileId: string;
  householdId: string;
  name: string;
  email: string;
  initials: string;
  role: HouseholdRole;
  joinedAt: string;
  lastActive: string;
  status: 'active' | 'invited';
}

export interface HouseholdMember {
  id: string;
  profileId: string;
  householdId: string;
  name: string;
  email: string;
  initials: string;
  joinedAt: string;
  lastActive: string;
  status: 'active' | 'invited';
}

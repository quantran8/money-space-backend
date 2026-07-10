import type { Household, UpdateFrequency } from '../entities/household.entity';

export const HOUSEHOLDS_REPOSITORY = Symbol('HOUSEHOLDS_REPOSITORY');

export interface CreateHouseholdInput {
  name: string;
  currency: string;
  updateFrequency: UpdateFrequency;
  /** The authenticated user creating (and owning) the household. */
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  /** Optional partner invite email. */
  inviteEmail?: string | null;
}

export interface HouseholdsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  getHouseholds(): Promise<Household[]>;
  /** Households where the given user is a member. */
  getHouseholdsForUser(userId: string): Promise<Household[]>;
  createHousehold(input: CreateHouseholdInput): Promise<Household>;
  countMembers(householdId?: string): Promise<number>;
}

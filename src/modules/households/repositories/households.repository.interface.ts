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
  /** Soft-delete the household and every membership in it. Audited. */
  deleteHousehold(householdId: string, actorId: string): Promise<void>;
  /**
   * Move `households.created_by` to another live member — the only way the
   * lifecycle safeguard changes hands. Audited.
   */
  transferSteward(
    householdId: string,
    toUserId: string,
    actorId: string,
  ): Promise<Household>;
  getHouseholds(): Promise<Household[]>;
  /** Households where the given user is a member. */
  getHouseholdsForUser(userId: string): Promise<Household[]>;
  createHousehold(input: CreateHouseholdInput): Promise<Household>;
  setDisplayCurrency(householdId: string, currency: string): Promise<void>;
  /** Rename the shared space. `name` is a column, unlike the config bag. */
  setName(householdId: string, name: string): Promise<void>;
  countMembers(householdId?: string): Promise<number>;
}

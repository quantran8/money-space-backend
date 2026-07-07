import type { Household } from '../entities/household.entity';

export const HOUSEHOLDS_REPOSITORY = Symbol('HOUSEHOLDS_REPOSITORY');

export interface HouseholdsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  getHouseholds(): Promise<Household[]>;
  countMembers(householdId?: string): Promise<number>;
}

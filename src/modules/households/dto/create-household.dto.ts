import type { UpdateFrequency } from '../entities/household.entity';

export interface CreateHouseholdDto {
  name: string;
  currency?: string;
  updateFrequency?: UpdateFrequency;
  /** Optional partner invite created alongside the household. */
  inviteEmail?: string;
}

import { Inject, Injectable } from '@nestjs/common';
import { HOUSEHOLDS_REPOSITORY } from './repositories/households.repository.interface';
import type { HouseholdsRepository } from './repositories/households.repository.interface';

@Injectable()
export class HouseholdsService {
  constructor(
    @Inject(HOUSEHOLDS_REPOSITORY)
    private readonly householdsRepository: HouseholdsRepository,
  ) {}

  async listHouseholds() {
    const items = await this.householdsRepository.getHouseholds();
    return {
      items,
      total: items.length,
    };
  }

  async getHousehold(householdId: string) {
    const household = await this.householdsRepository.assertHousehold(householdId);

    return {
      ...household,
      membersCount: await this.householdsRepository.countMembers(householdId),
    };
  }
}

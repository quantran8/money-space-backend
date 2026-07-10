import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import type { CreateHouseholdDto } from './dto/create-household.dto';
import { HOUSEHOLDS_REPOSITORY } from './repositories/households.repository.interface';
import type { HouseholdsRepository } from './repositories/households.repository.interface';

const ALLOWED_FREQUENCIES = ['weekly', 'monthly', 'manual'] as const;

@Injectable()
export class HouseholdsService {
  constructor(
    @Inject(HOUSEHOLDS_REPOSITORY)
    private readonly householdsRepository: HouseholdsRepository,
  ) {}

  /** Households the given user belongs to. Drives onboarding gating on the client. */
  async listMyHouseholds(user: AuthUser) {
    const items = await this.householdsRepository.getHouseholdsForUser(user.id);
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

  async createHousehold(user: AuthUser, payload: CreateHouseholdDto) {
    const name = payload.name?.trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }

    const inviteEmail = payload.inviteEmail?.trim();
    if (inviteEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail)) {
      throw new BadRequestException('inviteEmail is not a valid email');
    }

    const updateFrequency = ALLOWED_FREQUENCIES.includes(
      payload.updateFrequency as (typeof ALLOWED_FREQUENCIES)[number],
    )
      ? payload.updateFrequency!
      : 'manual';

    return this.householdsRepository.createHousehold({
      name,
      currency: payload.currency?.trim() || 'VND',
      updateFrequency,
      ownerId: user.id,
      ownerEmail: user.email,
      ownerName: user.displayName ?? user.fullName,
      inviteEmail: inviteEmail || null,
    });
  }
}

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import type { CreateHouseholdDto } from './dto/create-household.dto';
import { HOUSEHOLDS_REPOSITORY } from './repositories/households.repository.interface';
import type { HouseholdsRepository } from './repositories/households.repository.interface';

const ALLOWED_FREQUENCIES = ['weekly', 'monthly', 'manual'] as const;
const ALLOWED_CURRENCIES = ['VND', 'USD', 'EUR'] as const;

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
    const household =
      await this.householdsRepository.assertHousehold(householdId);

    return {
      ...household,
      membersCount: await this.householdsRepository.countMembers(householdId),
    };
  }

  /**
   * Delete the shared space. Irreversible from the app's point of view, which
   * is exactly why it is one of the three creator-only operations.
   */
  async deleteHousehold(householdId: string, user: AuthUser) {
    await this.householdsRepository.deleteHousehold(householdId, user.id);
    return { deleted: true, householdId };
  }

  /**
   * Hand the lifecycle safeguard to another member.
   *
   * Not a permission grant — there is only ever one steward, and the transfer
   * moves it rather than widening it. It exists so that a creator who leaves
   * cannot strand the household with nobody able to invite or remove anyone.
   */
  async transferSteward(
    householdId: string,
    payload: { toUserId?: string },
    user: AuthUser,
  ) {
    const toUserId = payload.toUserId?.trim();
    if (!toUserId) {
      throw new BadRequestException('toUserId is required');
    }
    if (toUserId === user.id) {
      throw new BadRequestException('You already hold this');
    }

    const household = await this.householdsRepository.transferSteward(
      householdId,
      toUserId,
      user.id,
    );
    return household;
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

  async updateConfig(householdId: string, payload: { currency?: string }) {
    await this.householdsRepository.assertHousehold(householdId);
    if (
      !ALLOWED_CURRENCIES.includes(
        payload.currency as (typeof ALLOWED_CURRENCIES)[number],
      )
    ) {
      throw new BadRequestException('currency must be VND, USD, or EUR');
    }
    await this.householdsRepository.setDisplayCurrency(
      householdId,
      payload.currency!,
    );
    return this.householdsRepository.assertHousehold(householdId);
  }
}

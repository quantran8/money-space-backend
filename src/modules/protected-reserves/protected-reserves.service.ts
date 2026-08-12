import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CreateProtectedReserveDto } from './dto/create-protected-reserve.dto';
import type { UpdateProtectedReserveDto } from './dto/update-protected-reserve.dto';
import type { ProtectedReserve } from './entities/protected-reserve.entity';
import { PROTECTED_RESERVES_REPOSITORY } from './repositories/protected-reserves.repository.interface';
import type { ProtectedReservesRepository } from './repositories/protected-reserves.repository.interface';

/**
 * CRUD over protected reserves (spec §19C).
 *
 * Deliberately transaction-free: every write here is a single statement
 * touching one table. Wrapping a single statement in an interactive
 * transaction buys nothing and costs a connection round-trip on the direct
 * (session-mode) client.
 *
 * The forecast reads reserves through its own bundle query, so this service is
 * a leaf — nothing else depends on it.
 */
@Injectable()
export class ProtectedReservesService {
  constructor(
    @Inject(PROTECTED_RESERVES_REPOSITORY)
    private readonly reservesRepository: ProtectedReservesRepository,
  ) {}

  async listProtectedReserves(householdId: string) {
    await this.reservesRepository.assertHousehold(householdId);
    const items =
      await this.reservesRepository.findReservesByHousehold(householdId);
    const activeTotal = items
      .filter((reserve) => reserve.status === 'active')
      .reduce((sum, reserve) => sum + reserve.amount, 0);

    return {
      householdId,
      items,
      total: items.length,
      // The number the forecast actually subtracts, returned alongside the list
      // so the client never has to re-derive (and never disagrees with) it.
      activeTotal,
    };
  }

  async getProtectedReserve(householdId: string, reserveId: string) {
    return this.ensureReserve(householdId, reserveId);
  }

  async createProtectedReserve(
    householdId: string,
    payload: CreateProtectedReserveDto,
  ) {
    const reserve: ProtectedReserve = {
      id: this.reservesRepository.createId('protected-reserve'),
      householdId,
      name: payload.name?.trim() ?? '',
      amount: payload.amount,
      status: payload.status ?? 'active',
      note: payload.note?.trim() || undefined,
    };

    this.assertValid(reserve);
    await this.reservesRepository.insertReserve(reserve);
    return reserve;
  }

  async updateProtectedReserve(
    householdId: string,
    reserveId: string,
    payload: UpdateProtectedReserveDto,
  ) {
    const reserve = await this.ensureReserve(householdId, reserveId);
    const next: ProtectedReserve = {
      ...reserve,
      name: payload.name?.trim() ?? reserve.name,
      amount: payload.amount ?? reserve.amount,
      status: payload.status ?? reserve.status,
      note:
        payload.note !== undefined
          ? payload.note.trim() || undefined
          : reserve.note,
    };

    this.assertValid(next);
    await this.reservesRepository.updateReserve(reserveId, next);
    return next;
  }

  async deleteProtectedReserve(householdId: string, reserveId: string) {
    await this.ensureReserve(householdId, reserveId);
    await this.reservesRepository.deleteReserve(reserveId);
    return { deleted: true, reserveId };
  }

  // --- internals -----------------------------------------------------------

  private assertValid(reserve: ProtectedReserve): void {
    if (!reserve.name) {
      throw new BadRequestException('name is required');
    }
    // A reserve is money set aside; a negative one has no meaning and would
    // silently INCREASE flexible money if it ever reached the forecast.
    if (!Number.isFinite(reserve.amount) || reserve.amount < 0) {
      throw new BadRequestException('amount must be a non-negative number');
    }
    if (reserve.status !== 'active' && reserve.status !== 'archived') {
      throw new BadRequestException('status must be "active" or "archived"');
    }
  }

  private async ensureReserve(householdId: string, reserveId: string) {
    const reserve = await this.reservesRepository.findReserveById(
      householdId,
      reserveId,
    );
    if (!reserve) {
      throw new NotFoundException(
        `Protected reserve "${reserveId}" was not found`,
      );
    }
    return reserve;
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  mapHousehold,
  numberFromDb,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { uuidv7 } from '../../../common/utils/uuid';
import { Household } from '../../households/entities/household.entity';
import type { ProtectedReserve } from '../entities/protected-reserve.entity';
import { ProtectedReservesRepository } from './protected-reserves.repository.interface';

@Injectable()
export class PrismaProtectedReservesRepository
  extends PrismaRepository
  implements ProtectedReservesRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(_prefix: string): string {
    return uuidv7();
  }

  async assertHousehold(householdId: string): Promise<Household> {
    const household = await this.prisma.household.findFirst({
      where: { id: householdId, deletedAt: null },
    });
    if (!household) {
      throw new NotFoundException(`Household "${householdId}" was not found`);
    }
    return mapHousehold(household);
  }

  async findReservesByHousehold(
    householdId: string,
  ): Promise<ProtectedReserve[]> {
    const rows = await this.prisma.protectedReserve.findMany({
      where: { householdId, deletedAt: null },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => this.toEntity(row));
  }

  async findActiveReserves(householdId: string): Promise<ProtectedReserve[]> {
    const rows = await this.prisma.protectedReserve.findMany({
      where: { householdId, deletedAt: null, status: 'active' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toEntity(row));
  }

  async findReserveById(
    householdId: string,
    reserveId: string,
  ): Promise<ProtectedReserve | undefined> {
    const row = await this.prisma.protectedReserve.findFirst({
      where: { id: reserveId, householdId, deletedAt: null },
    });
    return row ? this.toEntity(row) : undefined;
  }

  async insertReserve(reserve: ProtectedReserve): Promise<void> {
    // Single statement that also proves the household exists and is live: if
    // the SELECT yields no row nothing is inserted and we surface a 404,
    // without a separate round-trip.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO protected_reserves
        (id, household_id, name, amount, status, note, created_by, updated_at)
      SELECT
        ${reserve.id}::uuid,
        h.id,
        ${reserve.name},
        ${reserve.amount}::numeric,
        ${reserve.status}::"ReserveStatus",
        ${reserve.note ?? null},
        h.created_by,
        now()
      FROM households h
      WHERE h.id = ${reserve.householdId}::uuid
        AND h.deleted_at IS NULL
    `;

    if (inserted === 0) {
      throw new NotFoundException(
        `Household "${reserve.householdId}" was not found`,
      );
    }
  }

  async updateReserve(
    reserveId: string,
    reserve: ProtectedReserve,
  ): Promise<void> {
    await this.prisma.protectedReserve.updateMany({
      where: { id: reserveId, householdId: reserve.householdId, deletedAt: null },
      data: {
        name: reserve.name,
        amount: reserve.amount,
        status: reserve.status,
        note: reserve.note ?? null,
      },
    });
  }

  async deleteReserve(reserveId: string): Promise<void> {
    await this.prisma.protectedReserve.updateMany({
      where: { id: reserveId },
      data: { deletedAt: new Date() },
    });
  }

  private toEntity(row: {
    id: string;
    householdId: string;
    name: string;
    amount: unknown;
    status: string;
    note: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ProtectedReserve {
    return {
      id: row.id,
      householdId: row.householdId,
      name: row.name,
      amount: numberFromDb(row.amount),
      status: row.status as ProtectedReserve['status'],
      note: row.note ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

import type { Household } from '../../households/entities/household.entity';
import type { ProtectedReserve } from '../entities/protected-reserve.entity';

export const PROTECTED_RESERVES_REPOSITORY = Symbol(
  'PROTECTED_RESERVES_REPOSITORY',
);

export interface ProtectedReservesRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findReservesByHousehold(householdId: string): Promise<ProtectedReserve[]>;
  /** Only `active` reserves — the ones the forecast subtracts. */
  findActiveReserves(householdId: string): Promise<ProtectedReserve[]>;
  findReserveById(
    householdId: string,
    reserveId: string,
  ): Promise<ProtectedReserve | undefined>;
  insertReserve(reserve: ProtectedReserve): Promise<void>;
  updateReserve(reserveId: string, reserve: ProtectedReserve): Promise<void>;
  deleteReserve(reserveId: string): Promise<void>;
}

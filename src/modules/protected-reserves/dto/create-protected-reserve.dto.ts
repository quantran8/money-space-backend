import type { ReserveStatus } from '../entities/protected-reserve.entity';

export interface CreateProtectedReserveDto {
  name: string;
  amount: number;
  /** Defaults to `active` — a reserve you just declared is one you mean. */
  status?: ReserveStatus;
  note?: string;
}

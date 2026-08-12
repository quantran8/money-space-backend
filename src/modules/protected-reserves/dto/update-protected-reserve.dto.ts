import type { ReserveStatus } from '../entities/protected-reserve.entity';

export interface UpdateProtectedReserveDto {
  name?: string;
  amount?: number;
  status?: ReserveStatus;
  note?: string;
}

import type { DebtStatus } from '../entities/debt.entity';

export interface ListDebtsQuery {
  status?: DebtStatus;
  limit?: string;
}

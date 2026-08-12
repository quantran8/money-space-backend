export type ReserveStatus = 'active' | 'archived';

/**
 * Money the household has decided to keep untouched (spec §19C).
 *
 * A reserve is a CONSTRAINT on the forecast, not an account: nothing is moved
 * anywhere. It is subtracted when computing flexible money, so "how much can we
 * spend without breaking what we promised ourselves" has an answer.
 *
 * Only `active` reserves are subtracted. `archived` keeps the record (and its
 * history) without letting it distort today's picture — which is why archiving
 * exists at all instead of just deleting.
 */
export interface ProtectedReserve {
  id: string;
  householdId: string;
  name: string;
  amount: number;
  status: ReserveStatus;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
}

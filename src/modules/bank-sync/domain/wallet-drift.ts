// The bank's reported balance is the wallet's truth. See memory/bank-sync.md (Số dư).

export interface BalanceObservation {
  assetId: string;
  bankEventId: string;
  reportedBalance: number;
  currentValue: number;
  /** A cash movement was recorded on the wallet after this event's money event. */
  superseded: boolean;
}

/** The value to set the wallet to, or null when there is nothing to sync. */
export function balanceSyncTarget(obs: BalanceObservation): number | null {
  if (obs.superseded || obs.reportedBalance === obs.currentValue) return null;
  return obs.reportedBalance;
}

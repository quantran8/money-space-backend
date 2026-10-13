// Bank-reported balance vs ledger balance after the same event. See memory/cashflow-settlement.md.

export interface BalanceObservation {
  assetId: string;
  assetName: string;
  bankEventId: string;
  reportedBalance: number;
  observedAt: Date;
  timeSource: string | null;
  /** Ledger balance right after this event's money event; null when no point exists. */
  ledgerBalance: number | null;
  currentValue: number;
  /** Signed sum of `asset_update` adjustments recorded after this event. */
  adjustedSince: number;
}

export interface WalletDrift {
  assetId: string;
  assetName: string;
  bankEventId: string;
  observedAt: string;
  timeSource: string | null;
  reportedBalance: number;
  ledgerBalance: number;
  drift: number;
  /** Current balance that would make the ledger agree with the bank. */
  suggestedValue: number;
}

export function toWalletDrift(obs: BalanceObservation): WalletDrift | null {
  if (obs.ledgerBalance === null) return null;
  const drift = obs.reportedBalance - obs.ledgerBalance - obs.adjustedSince;
  return {
    assetId: obs.assetId,
    assetName: obs.assetName,
    bankEventId: obs.bankEventId,
    observedAt: obs.observedAt.toISOString(),
    timeSource: obs.timeSource,
    reportedBalance: obs.reportedBalance,
    ledgerBalance: obs.ledgerBalance,
    drift,
    suggestedValue: obs.currentValue + drift,
  };
}

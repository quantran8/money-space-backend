import { toWalletDrift, type BalanceObservation } from './wallet-drift';

const obs = (over: Partial<BalanceObservation> = {}): BalanceObservation => ({
  assetId: 'w-1',
  assetName: 'VCB',
  bankEventId: 'evt-1',
  reportedBalance: 100_000_000,
  observedAt: new Date('2026-10-25T03:00:00Z'),
  timeSource: 'CONTENT',
  ledgerBalance: 100_000_000,
  currentValue: 99_945_000,
  adjustedSince: 0,
  ...over,
});

describe('toWalletDrift', () => {
  it('reports zero drift when every notification arrived', () => {
    expect(toWalletDrift(obs())?.drift).toBe(0);
  });

  it('reports a missed notification as drift and the value that fixes it', () => {
    const drift = toWalletDrift(obs({ ledgerBalance: 100_055_000 }));
    expect(drift?.drift).toBe(-55_000);
    expect(drift?.suggestedValue).toBe(99_890_000);
  });

  it('shows a manual completion plus a bank post as positive ledger excess', () => {
    expect(toWalletDrift(obs({ ledgerBalance: 130_000_000 }))?.drift).toBe(
      -30_000_000,
    );
  });

  it('clears once the suggested adjustment has been recorded', () => {
    const before = toWalletDrift(obs({ ledgerBalance: 100_055_000 }))!;
    const after = toWalletDrift(
      obs({
        ledgerBalance: 100_055_000,
        currentValue: before.suggestedValue,
        adjustedSince: before.drift,
      }),
    );
    expect(after?.drift).toBe(0);
  });

  it('skips an observation with no ledger point', () => {
    expect(toWalletDrift(obs({ ledgerBalance: null }))).toBeNull();
  });
});

import { balanceSyncTarget, type BalanceObservation } from './wallet-drift';

const obs = (over: Partial<BalanceObservation> = {}): BalanceObservation => ({
  assetId: 'w-1',
  bankEventId: 'evt-1',
  reportedBalance: 100_000_000,
  currentValue: 99_945_000,
  superseded: false,
  ...over,
});

describe('balanceSyncTarget', () => {
  it('sets the wallet to the reported balance', () => {
    expect(balanceSyncTarget(obs())).toBe(100_000_000);
  });

  it('does nothing when the wallet already agrees', () => {
    expect(balanceSyncTarget(obs({ currentValue: 100_000_000 }))).toBeNull();
  });

  it('never rolls a wallet back to a balance a later movement replaced', () => {
    expect(balanceSyncTarget(obs({ superseded: true }))).toBeNull();
  });
});

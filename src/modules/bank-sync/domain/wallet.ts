import type { WalletRef } from '../entities/bank-sync.entity';

const WALLET_TYPES = new Set(['cash', 'bank_account']);

/** Only a live cash/bank wallet can receive a bank posting. */
export function isPostableWallet(
  wallet: WalletRef | null,
): wallet is WalletRef {
  return (
    wallet !== null &&
    wallet.deletedAt === null &&
    wallet.status === 'active' &&
    WALLET_TYPES.has(wallet.type)
  );
}

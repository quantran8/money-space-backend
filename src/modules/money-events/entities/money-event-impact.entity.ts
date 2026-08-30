import type { WalletOverdraft } from '../../assets/assets.service';

/**
 * Advisory preview of what a money-event edit or delete would do to the wallets
 * it touches, before it is written. Empty `wallets` means nothing to warn about.
 *
 * A wallet is listed only when the change would drive it below zero at some
 * point in its timeline. That is allowed — it truthfully records spending that
 * exceeds recorded income — so this warns rather than blocks.
 */
export interface MoneyEventImpact {
  /** No wallet would go negative. */
  isClear: boolean;
  wallets: Array<{
    assetId: string;
    assetName: string;
    /** Deepest point the balance reaches (most negative). */
    lowestBalance: number;
    /** Date the balance first goes negative. */
    firstOverdraftDate: string;
    overdrafts: WalletOverdraft[];
  }>;
}

/** How interest is paid out during the term. Persisted via `payoutFrequency`. */
export type InterestPayment = 'end_of_term' | 'monthly';

/**
 * Where auto-credited monthly interest lands. Only meaningful when
 * `interestPayment === 'monthly'`.
 * - `wallet`: credit `receivingWalletId` (a cash/bank asset) each month.
 * - `principal`: capitalize the interest into the deposit (compounds).
 */
export type InterestDestination = 'wallet' | 'principal';

/** Why a term stopped being active. `matured` is the happy path. */
export type CalculationTermStatus =
  'active' | 'matured' | 'closed' | 'cancelled';

export interface CalculationTerm {
  calculationType:
    'saving_deposit' | 'bond' | 'loan_receivable' | 'certificate_of_deposit';
  /**
   * The deposit's CURRENT balance. Capitalizing interest rewrites this in
   * place, so it is principal + everything capitalized so far — not what was
   * deposited. For that, read `basePrincipalAmount`.
   */
  principalAmount: number;
  /**
   * What was actually deposited, fixed at creation.
   *
   * Early withdrawal claws interest back against money the household really
   * put in, and settling a `wallet`-destination deposit pays back only this
   * (its interest already left month by month). Optional: rows written before
   * the column existed fall back to `principalAmount`, which is correct for
   * them because nothing had ever capitalized.
   */
  basePrincipalAmount?: number;
  /** Lifecycle state. Settling a deposit moves it off `active`. */
  status?: CalculationTermStatus;
  interestRate: number;
  startDate: string;
  maturityDate: string | null;
  /** Interest payout schedule (kỳ trả lãi). */
  interestPayment: InterestPayment;
  /**
   * Non-term interest rate (lãi suất không kỳ hạn), annual %. Applied when a
   * saving deposit is withdrawn before maturity. Required for saving_deposit;
   * defaults to 0 for other formula types.
   */
  nonTermRate: number;
  /** Destination for auto-credited monthly interest. Defaults to `principal`. */
  interestDestination: InterestDestination;
  /** Wallet asset that receives monthly interest when destination = `wallet`. */
  receivingWalletId: string | null;
}

/**
 * A saving deposit reached its end and became a spendable account.
 *
 * The payload a notification will carry when there is one to carry it. Today
 * `AssetsService.announceDepositSettled` writes it to the household journal and
 * nothing more — see memory/asset-valuation.md for why no placeholder table was
 * created. Keeping the shape here means wiring an inbox later changes the
 * seam's body and no caller.
 */
export interface DepositSettledEvent {
  householdId: string;
  assetId: string;
  assetName: string;
  /** Maturity date, or the day it was withdrawn — never "today". */
  settledOn: string;
  /** What was deposited. */
  principal: number;
  /** Interest kept (negative when an early withdrawal clawed some back). */
  interest: number;
  /** What landed in the account. */
  payout: number;
  reason: 'matured' | 'withdrawn_early';
}

/** How interest is paid out during the term. Persisted via `payoutFrequency`. */
export type InterestPayment = 'end_of_term' | 'monthly';

/**
 * Where auto-credited monthly interest lands. Only meaningful when
 * `interestPayment === 'monthly'`.
 * - `wallet`: credit `receivingWalletId` (a cash/bank asset) each month.
 * - `principal`: capitalize the interest into the deposit (compounds).
 */
export type InterestDestination = 'wallet' | 'principal';

export interface CalculationTerm {
  calculationType:
    'saving_deposit' | 'bond' | 'loan_receivable' | 'certificate_of_deposit';
  principalAmount: number;
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

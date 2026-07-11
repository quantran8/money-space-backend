import type { CreateDebtDto } from './create-debt.dto';

/**
 * Why a debt's `originalAmount` changed. Only meaningful under `effective` mode,
 * where a bare amount change is ambiguous (see memory/debts.md):
 * - `fix_original` — the original number was wrong; treat as a correction.
 * - `additional_disbursement` — borrowed more from `effectiveDate`.
 * - `reconcile_balance` — set outstanding to a stated actual (e.g. a statement).
 */
export type DebtBalanceIntent =
  'fix_original' | 'additional_disbursement' | 'reconcile_balance';

/**
 * How to apply an update to a debt that already has money-event history.
 * - `correction` — the original data was wrong; recompute outstanding and
 *   rewrite the schedule as if the corrected values were always true.
 * - `effective` — a change that takes effect from `effectiveDate`; history
 *   before that date stays untouched.
 * Omitted entirely for debts with no history (the simple overwrite path).
 */
export type DebtUpdateMode =
  | { kind: 'correction' }
  | {
      kind: 'effective';
      /** ISO yyyy-mm-dd the change takes effect. Required for `effective`. */
      effectiveDate: string;
      /** Present only when `originalAmount` changed (the ambiguous case). */
      balanceIntent?: DebtBalanceIntent;
    };

export interface UpdateDebtDto extends Partial<CreateDebtDto> {
  /**
   * Required when the debt already has money-event history (a borrow inflow or
   * recorded repayments). Absent for a no-history debt, which keeps the simple
   * direct-overwrite behaviour.
   *
   * Note on `originalAmount` for the `additional_disbursement` and
   * `reconcile_balance` intents: for a disbursement the new `originalAmount` is
   * persisted (the total borrowed rises); for a reconcile the typed amount is
   * carried in `outstandingAmount`, not `originalAmount`.
   */
  updateMode?: DebtUpdateMode;
}

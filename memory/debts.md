# Debts / liabilities

Loans the household still owes, with repayment estimation. Related: [[money-events]], [[assets]], [[snapshots-and-networth]].

## Overview

CRUD over `Debt` (name, debtType, lenderType, lenderName, original/outstanding amount, borrowedAt, expectedFinalDueDate, status, owner member, optional `receivedToAsset` link).

## Key invariant: borrowing does not inflate net worth

A debt links to the asset that received the money (`receivedToAssetId`). Borrowing raises an asset **and** a debt equally → **net worth unchanged**. See [[domain-overview]].

**Enforced on create.** `createDebt`, inside its transaction, credits the receiving wallet when `receivedToAssetId` is set — but it does **not** credit the wallet directly anymore. It logs an inflow money event linked to that wallet, and `MoneyEventsService.createMoneyEvent` performs the wallet credit itself (see [[money-events]]: an event moves its linked wallets). Only `cash` / `bank_account` wallets hold a free balance, so an event linking any other asset type is a no-op credit. Everything shares the debt-create transaction, so the debt row and the wallet bump land (or roll back) together. `DebtsModule` imports `MoneyEventsModule` (not `AssetsModule` — the wallet move now lives in the events layer). Deleting the debt reverses the credit through the same events path — see [[#Delete]].

## Side effects of creating a debt (all in the create transaction)

When `receivedToAssetId` is set, `createDebt` **logs a money event** — an inflow `debt_update` event (`title: "Vay: <name>"`, `category: 'debt'`, `direction: 'inflow'` set explicitly because `debt_update` otherwise derives to outflow), linked to both `toAssetId` (the wallet) and `debtId`, dated `borrowedAt ?? AS_OF`. Via `MoneyEventsService.createMoneyEvent` (`DebtsModule` imports `MoneyEventsModule`). This single call both **puts the borrowed cash in the events timeline** and **credits the wallet** (net worth unchanged) — there is no separate `creditManualAsset` call.

Independent of the wallet, `createDebt` **materializes the repayment schedule** (`createRepaymentSchedule`): when `paymentFrequency` is monthly/quarterly/yearly **and** a per-period amount exists (`fixedPaymentAmount`, else `minimumPaymentAmount`), it creates `UpcomingPayment` rows (`name: "Tra no: <name>"`, linked `debtId`) in **one bulk insert** via `PaymentsService.createUpcomingPayments` (`DebtsModule` imports `PaymentsModule`). Due dates step from `borrowedAt ?? AS_OF` by the frequency (`addMonthsIso`, clamps to month-end). With an `expectedFinalDueDate` it fills the schedule up to that date (capped at `MAX_GENERATED_INSTALLMENTS = 60`); without one it creates just the **next** due reminder. The whole `createDebt` transaction runs with a raised `timeout` (15s) and uses one bulk write for the schedule so it stays well under the interactive-transaction limit. `updateDebt` does **not** yet regenerate the schedule or adjust the wallet.

## Updating a debt: correction vs. effective-from-now

**Repayment terms live directly on the `debts` row** (folded in from the former
`debt_terms` table, which was a 1:1 singleton of derived values — migration
`..._fold_debt_terms`): `payment_frequency`, `fixed_payment_amount`,
`minimum_payment_amount`, `interest_type`, `interest_calculation`.
`repayment_type` / `has_interest` are derived on read. `insertDebt`/`updateDebt`
persist these columns directly — there is no `upsertDebtTerms` anymore.

`updateDebt` behaves differently once a debt **has money-event history** (any event links to it — the borrow inflow or a recorded repayment; detected via `MoneyEventsService.findMoneyEventsByDebt`). A **no-history** debt keeps the simple direct-overwrite path (row + `upsertDebtInterestPeriods`), no mode, no audit.

A **history-ful** update **must** carry `payload.updateMode` (`UpdateDebtDto`), else **400** (an old client must not silently rewrite history). Two modes:

- **`{ kind: 'correction' }`** (`applyCorrection`) — the original data was wrong; treat the corrected values as always true. Recompute `outstandingAmount = max(0, correctedOriginal − Σ recorded repayment outflows)` (repayments = the debt's **outflow** money events), rewrite the whole schedule via the delete-all `upsertDebtInterestPeriods`, and **do not** touch recorded events or upcoming payments. Audit `debt.corrected`.
- **`{ kind: 'effective', effectiveDate, balanceIntent? }`** (`applyEffective`) — a change from `effectiveDate`; history before it is untouched. Per changed field:
  - **interest rate** → `closeLatestInterestPeriodAt(debtId, effectiveDate)` then `appendInterestPeriod(...)` (do **not** wipe old stages). The new rate is the payload scalar `interestRate`.
  - **fixedPaymentAmount** → `PaymentsService.updateUnpaidUpcomingPaymentAmounts` (only reminders with `dueDate >= effectiveDate`); the amount persists on the debts row via `updateDebt`. Recorded repayments (money events) are inherently untouched.
  - **debtType / core scalars** → set on the row; audit only.
  - **originalAmount changed** → requires `balanceIntent` (else 400; never auto-infer):
    - `fix_original` → delegates to `applyCorrection` (audit `debt.corrected`).
    - `additional_disbursement` → `originalAmount` **rises to the new value** and `outstandingAmount += delta`; if `receivedToAssetId` set, log a `debt_update` **inflow** event (credits wallet, does NOT auto-reduce). Audit `debt.additional_disbursement`.
    - `reconcile_balance` → the typed amount arrives as `outstandingAmount` (frontend moves it off `originalAmount`); set outstanding directly and log a **neutral `adjustment`** event (no wallet move, no auto-reduce). Audit `debt.balance_reconciled`.

**Correctness hinge**: every event created in an update is inflow or neutral, so `createMoneyEvent`'s auto-reduce (debt-linked **outflow** only, see [[money-events]]) never fires — outstanding is set explicitly. Never make these outflow events. All effects run in one `runInTransaction` (`timeout 15000`); nested `createMoneyEvent`/`upsertDebtInterestPeriods` reuse the outer transaction.

**Audit log** (`DebtsRepository.writeAuditLog`, `audit_logs` table): `entityType 'debt'`, actor resolved from `households.created_by` (debt endpoints have no request user — same source as `insertDebt`'s `created_by`). Actions: `debt.corrected`, `debt.updated_effective`, `debt.additional_disbursement`, `debt.balance_reconciled`. Metadata: `{ mode, effectiveDate?, balanceIntent?, before, after, changed[], loggedEventId? }`.

## Interest modeling

- **Interest stages**: a debt has one or more `InterestPeriod` (annual `ratePct` + `months`). An empty-`months` stage absorbs the remaining term. Stage length persists in the real `debt_interest_periods.term_months` column (previously smuggled into `note` as `"months:N"` — migrated to a real column in `..._drop_dead_columns`).
- `monthsBetween` → term in months.
- `totalInstallments(frequency, termMonths)` = `round((termMonths/12) × periodsPerYear)`, min 1.
  - `periodsPerYear`: monthly = 12, quarterly = 4, yearly = 1, none = 0.
- `averageAnnualRate` = **term-weighted average** of the stage rates.

## Repayment estimation (`estimateRepayment`)

Two models (`InterestCalc = fixed | reducing`):

- **`fixed` (annuity)** — `PMT = P·r / (1 − (1+r)^−n)` (standard bank annuity); interest on the shrinking balance.
- **`reducing` (flat on principal)** — principal split evenly `P/n`; interest on outstanding. Returns the **first (largest)** installment as the conservative planning figure.
- **Zero-rate** → straight `P/n` split.

Backend enum bridge (`calcToBackendEnum`): `fixed → reducing_balance`, `reducing → flat_rate`. Stages serialize to/from `debt_interest_periods` DTOs.

## Backend interest enums (richer than frontend)

`DebtInterestCalculation = simple_interest | reducing_balance | flat_rate | custom`. Repayment terms are columns on `debts` (folded in from the dropped `debt_terms` table). Remaining child table: `DebtInterestPeriod` (staged/floating/promotional rates over date ranges).

## Validation invariants (`buildDebtSchema`)

- original & outstanding both **> 0**.
- **outstanding must not exceed original.**

## Summary metrics

Outstanding total, active count, overdue count, monthly-planned repayment.

## Delete

Deleting a debt removes **everything the debt created**, in one transaction. Soft-delete (`deletedAt`) the debt row + its interest periods, then:

- **Soft-delete the generated upcoming payments** (`deleteUpcomingPaymentsByDebt` — rows where `debtId` matches and `deletedAt IS NULL`).
- **Soft-delete the linked money events and reverse their wallet moves** — `MoneyEventsService.deleteMoneyEventsByDebt(householdId, debtId)` soft-deletes every event linked to the debt (the borrow inflow and any repayments) and reverses each one's wallet effect (so the borrow credit into the received-to wallet is undone). This replaces the earlier repo `deleteMoneyEventsByDebt` + a manual `AssetsService.debitManualAsset` — the wallet reversal now lives in the events layer. Net worth returns to where it was before the debt existed; a debit floors the wallet at 0.

(The delete repo methods replaced the earlier `unlinkDebtFrom*` methods, which only set `debtId = null` — related records are now deleted, not just unlinked.)

## Where it lives in code

- **frontend-web**: `src/features/debts/{model/debts-interest.ts, model/debts-form.ts, model/debts.types.ts, api/debts.repository.ts, hooks/use-debts.ts, hooks/use-debts-page.ts}`.
- **backend**: `src/modules/debts/` (`debts.service.ts`, `entities/debt.entity.ts`, `repositories/prisma-debts.repository.ts`).
- **mobile-app**: to be ported.

## Enums

`DebtType` (8), `LenderType` (6), `DebtStatus = active | paid_off | paused | overdue | cancelled`, `PaymentFrequency = none | monthly | quarterly | yearly`, `InterestCalc = fixed | reducing`.

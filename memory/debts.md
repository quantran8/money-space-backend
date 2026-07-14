# Debts / liabilities

Loans the household still owes, with repayment estimation. Related: [[money-events]], [[assets]], [[snapshots-and-networth]].

## Overview

CRUD over `Debt` (name, **lenderType**, lenderName, original/outstanding amount, borrowedAt, expectedFinalDueDate, status, owner member, optional `receivedToAsset` link).

## Lender type — the single classification (drives repayment rules)

A debt is classified by **one** field, `lenderType` (the old dual `debtType` + `lenderType` was collapsed — migration `..._debt_lender_type_simplify` drops the `debt_type` column and its enum, and rewrites `LenderType` to three values). `isFixedScheduleLender(lenderType)` in the entity is the single predicate the rules key on:

- **`bank_institution`** — a *fixed-schedule* loan. On create/update `DebtsService.assertLenderTerms` **requires** an interest rate (a positive `interestRate` or a period with one), an `expectedFinalDueDate` (its term), and a positive `fixedPaymentAmount` (else **400**). Its repayment money events are **locked**: the only sanctioned way to change what was paid is to update the debt record so the schedule recomputes.
- **`relative`** / **`other`** — interest and a fixed term are **optional**. When the user sets an amount + schedule, editing (or creating/deleting) a repayment event **rebalances the next unpaid installment** by the over/under-payment (see below). All three terms are optional.

The old 6-value LenderType migrated as: `family, friend → relative`; `bank, credit_institution → bank_institution`; `company, other → other`.

## Repayment-event side effects (money-events layer)

Recording, editing, or deleting a debt **repayment** (a debt-linked **outflow** money event) runs `MoneyEventsService.applyDebtRepaymentEffects(event, sign)` inside the event's transaction (`sign = -1` to apply on create, `+1` to reverse on the old event before re-applying the new one on edit, `+1` on delete). It:

1. **Adjusts the debt's `outstandingAmount`** by the paid amount (`adjustDebtOutstanding`, floored at 0 — a repayment lowers it, a reversal raises it back). *(create already did this via the former `reduceDebtOutstanding`; edit/delete previously did **not** touch outstanding — that gap is now closed so an edited/deleted repayment keeps outstanding correct.)*
2. For **`relative`/`other` debts with a fixed installment set** (`fixedPaymentAmount`): `adjustNextUnpaidPayment` shifts the next unpaid `UpcomingPayment` (earliest non-`paid` row due on/after the event date) by `−overpayment` where `overpayment = amount − fixedPaymentAmount`. **Overpay → next installment shrinks; underpay → it grows** (`max(0, …)`). Total owed and installment count are unchanged. No-op when the debt has no future unpaid installment.

**Bank/institution is never rebalanced** (its schedule is fixed) and `assertRepaymentEditable` **rejects** any `updateMoneyEvent`/`deleteMoneyEvent` on a `bank_institution` repayment (**400**). The check keys on *debt-linked outflow*, so the debt's own borrow **inflow** (`debt_update` inflow) is exempt — `resyncBorrowEventDate` can still re-date it. `relative`/`other` repayments stay editable.

## Key invariant: borrowing does not inflate net worth

A debt links to the asset that received the money (`receivedToAssetId`). Borrowing raises an asset **and** a debt equally → **net worth unchanged**. See [[domain-overview]].

**Enforced on create.** `createDebt`, inside its transaction, credits the receiving wallet when `receivedToAssetId` is set — but it does **not** credit the wallet directly anymore. It logs an inflow money event linked to that wallet, and `MoneyEventsService.createMoneyEvent` performs the wallet credit itself (see [[money-events]]: an event moves its linked wallets). Only `cash` / `bank_account` wallets hold a free balance, so an event linking any other asset type is a no-op credit. Everything shares the debt-create transaction, so the debt row and the wallet bump land (or roll back) together. `DebtsModule` imports `MoneyEventsModule` (not `AssetsModule` — the wallet move now lives in the events layer). Deleting the debt reverses the credit through the same events path — see [[#Delete]].

## Side effects of creating a debt (all in the create transaction)

When `receivedToAssetId` is set, `createDebt` **logs a money event** — an inflow `debt_update` event (`title: "Vay: <name>"`, `category: 'debt'`, `direction: 'inflow'` set explicitly because `debt_update` otherwise derives to outflow), linked to both `toAssetId` (the wallet) and `debtId`, dated `borrowedAt ?? AS_OF`. Via `MoneyEventsService.createMoneyEvent` (`DebtsModule` imports `MoneyEventsModule`). This single call both **puts the borrowed cash in the events timeline** and **credits the wallet** (net worth unchanged) — there is no separate `creditManualAsset` call.

Independent of the wallet, `createDebt` **materializes the repayment schedule** (`createRepaymentSchedule`): when `paymentFrequency` is monthly/quarterly/yearly **and** a per-period amount exists (`fixedPaymentAmount`, else `minimumPaymentAmount`), it creates `UpcomingPayment` rows (`name: "Tra no: <name>"`, linked `debtId`) in **one bulk insert** via `PaymentsService.createUpcomingPayments` (`DebtsModule` imports `PaymentsModule`). Due dates step from `borrowedAt ?? AS_OF` by the frequency (`addMonthsIso`, clamps to month-end). With an `expectedFinalDueDate` it fills the schedule up to that date (capped at `MAX_GENERATED_INSTALLMENTS = 60`); without one it creates just the **next** due reminder. The whole `createDebt` transaction runs with a raised `timeout` (15s) and uses one bulk write for the schedule so it stays well under the interactive-transaction limit. `updateDebt` does **not** yet regenerate the schedule or adjust the wallet — **except** that a moved `borrowedAt` re-dates the borrow inflow event (see below).

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
  - **lenderType / core scalars** → set on the row; audit only.
  - **originalAmount changed** → requires `balanceIntent` (else 400; never auto-infer):
    - `fix_original` → delegates to `applyCorrection` (audit `debt.corrected`).
    - `additional_disbursement` → `originalAmount` **rises to the new value** and `outstandingAmount += delta`; if `receivedToAssetId` set, log a `debt_update` **inflow** event (credits wallet, does NOT auto-reduce). Audit `debt.additional_disbursement`.
    - `reconcile_balance` → the typed amount arrives as `outstandingAmount` (frontend moves it off `originalAmount`); set outstanding directly and log a **neutral `adjustment`** event (no wallet move, no auto-reduce). Audit `debt.balance_reconciled`.

**Correctness hinge**: every event created in an update is inflow or neutral, so `createMoneyEvent`'s auto-reduce (debt-linked **outflow** only, see [[money-events]]) never fires — outstanding is set explicitly. Never make these outflow events. All effects run in one `runInTransaction` (`timeout 15000`); nested `createMoneyEvent`/`upsertDebtInterestPeriods` reuse the outer transaction.

**Re-dating the borrow inflow on a `borrowedAt` change** (`resyncBorrowEventDate`): the borrow inflow event `createDebt` logged ("Vay: …", the sole `debt_update` **inflow** linked to the debt) is dated at the original `borrowedAt`. When a history-ful update moves `borrowedAt`, both mode paths (`applyCorrection` and `applyEffective`) re-date that event inside their transaction via `MoneyEventsService.updateMoneyEvent({ isoDate: next.borrowedAt })`, which re-syncs the event row **and** the wallet valuation history point it wrote at the old date (reverse → `removeValuationsForEvent` → re-apply). No-op when `borrowedAt` is unchanged/unset or no borrow inflow exists. Repayment outflows and reconcile/adjustment neutrals are never re-dated. (A no-history debt takes the direct-overwrite path and has no borrow event to re-date.)

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

Deleting a debt removes **everything the debt created**, in one transaction (raised `timeout: 30000` — the money-event reversal below fans out with the number of linked events, so it must not abort under the 5s default and strand the connection). Soft-delete (`deletedAt`) the debt row + its interest periods, then:

- **Soft-delete the generated upcoming payments** (`deleteUpcomingPaymentsByDebt` — rows where `debtId` matches and `deletedAt IS NULL`).
- **Soft-delete the linked money events and reverse their wallet moves** — `MoneyEventsService.deleteMoneyEventsByDebt(householdId, debtId)` soft-deletes every event linked to the debt (the borrow inflow and any repayments) and reverses each one's wallet effect (so the borrow credit into the received-to wallet is undone). It **bulk soft-deletes all the event rows in one `updateMany`** (repo `deleteMoneyEventsByDebt` — `where: { householdId, debtId, deletedAt: null }`), then loops the fetched events to reverse each one's wallet effect (that part can't be bulked — every event moves different wallets). This replaces the earlier per-row delete + a manual `AssetsService.debitManualAsset` — the wallet reversal now lives in the events layer. Net worth returns to where it was before the debt existed; a debit floors the wallet at 0.

(The delete repo methods replaced the earlier `unlinkDebtFrom*` methods, which only set `debtId = null` — related records are now deleted, not just unlinked.)

## Where it lives in code

- **frontend-web**: `src/features/debts/{model/debts-interest.ts, model/debts-form.ts, model/debts.types.ts, api/debts.repository.ts, hooks/use-debts.ts, hooks/use-debts-page.ts}`.
- **backend**: `src/modules/debts/` (`debts.service.ts`, `entities/debt.entity.ts`, `repositories/prisma-debts.repository.ts`).
- **mobile-app**: to be ported.

## Enums

`LenderType = relative | bank_institution | other` (the sole debt classification — `DebtType` was dropped), `DebtStatus = active | paid_off | paused | overdue | cancelled`, `PaymentFrequency = none | monthly | quarterly | yearly`, `InterestCalc = fixed | reducing`.

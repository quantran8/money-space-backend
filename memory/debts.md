# Debts / liabilities

Loans the household still owes, with repayment estimation. Related: [[money-events]], [[assets]], [[snapshots-and-networth]].

## Overview

CRUD over `Debt` (name, debtType, lenderType, lenderName, original/outstanding amount, borrowedAt, expectedFinalDueDate, status, owner member, optional `receivedToAsset` link).

## Key invariant: borrowing does not inflate net worth

A debt links to the asset that received the money (`receivedToAssetId`). Borrowing raises an asset **and** a debt equally → **net worth unchanged**. See [[domain-overview]].

## Interest modeling

- **Interest stages**: a debt has one or more `InterestPeriod` (annual `ratePct` + `months`). An empty-`months` stage absorbs the remaining term.
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

`DebtInterestCalculation = simple_interest | reducing_balance | flat_rate | custom`; repayment types `flexible | fixed_schedule | installment | interest_only | minimum_payment | bullet_payment`. Child tables: `DebtTerm` (repayment type, payment frequency, amounts, grace period), `DebtInterestPeriod` (staged/floating/promotional rates over date ranges).

## Validation invariants (`buildDebtSchema`)

- original & outstanding both **> 0**.
- **outstanding must not exceed original.**

## Summary metrics

Outstanding total, active count, overdue count, monthly-planned repayment.

## Delete

Soft-delete + unlink from upcoming payments and money events.

## Where it lives in code

- **frontend-web**: `src/features/debts/{model/debts-interest.ts, model/debts-form.ts, model/debts.types.ts, api/debts.repository.ts, hooks/use-debts.ts, hooks/use-debts-page.ts}`.
- **backend**: `src/modules/debts/` (`debts.service.ts`, `entities/debt.entity.ts`, `repositories/prisma-debts.repository.ts`).
- **mobile-app**: to be ported.

## Enums

`DebtType` (8), `LenderType` (6), `DebtStatus = active | paid_off | paused | overdue | cancelled`, `PaymentFrequency = none | monthly | quarterly | yearly`, `InterestCalc = fixed | reducing`.

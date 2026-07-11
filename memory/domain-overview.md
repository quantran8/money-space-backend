# Domain overview

## What Money Space is

A Vietnamese-first **family/couple finance dashboard** — explicitly **not** a transaction-tracking / expense-logging app. The core question it answers is *"Nhà mình đang ổn không?"* (Is our household OK?).

- Central concept is a periodic **financial snapshot** (weekly/monthly), not per-transaction ledgering.
- Calm, non-judgmental tone: use "khoản cần chú ý / cần trao đổi", never "cảnh báo / vượt chi / đáng ngờ".
- Flexible privacy/sharing so the money-holder isn't made to feel surveilled.

## Aggregate root

**`Household`** is the aggregate root. Nearly every domain entity is scoped to a `householdId` and cascades on household delete. All financial reads/writes are keyed by household. Base currency is **VND**.

## Money & precision

- Money stored as VND numbers (backend: `Decimal(14,2)`).
- Quantities / prices / FX rates: `Decimal(20,8)`.
- Display shorthand `formatVndShort` → "24,5M" (comma is the decimal separator, Vietnamese locale).

## Global invariants (apply across all repos)

1. **Valuation mode is derived from asset type, never user-chosen.** See [[asset-valuation]].
2. **Net worth cannot inflate from borrowing** — borrowing raises an asset **and** a debt equally. A debt records `receivedToAssetId`. See [[debts]].
3. **Formula-based assets stop accruing interest at maturity** (simple, non-compounding interest). See [[asset-valuation]].
4. **Snapshots are immutable** — editing an old valuation must not silently rewrite past snapshots. See [[snapshots-and-networth]].
5. **Goal `current ≤ target`; debt `outstanding ≤ original`.** See [[goals]], [[debts]].
6. **`payment_paid` / `goal_contribution` events must be linked** to their payment/goal; transfers require distinct from/to assets. See [[money-events]].
7. Market pricing & FX are currently **stubbed** (frontend `latestPrice→null`, `fxToVnd→1`; backend defaults FX to 1). See [[asset-valuation]], [[market-data]].

## Hardcoded "now" (demo state)

The app is in a seed/demo state. A hardcoded valuation date is used across asset/date math instead of the real clock:
- frontend-web: `AS_OF = '2026-07-06'` (assets); `TODAY = '2026-07-08'` (events).
- backend: `AS_OF` in `src/common/utils/money-space.utils.ts`; dashboard `totalDebt` is temporarily hard-coded to `18,000,000` (known demo shortcut, not a real rollup).

When real-time is wired, replace these constants — they affect interest accrual, due-date buckets, and snapshot dating.

## Feature index

- [[asset-valuation]] — the core valuation engine (type → mode → value)
- [[assets]] — assets feature (CRUD, liquidity buckets)
- [[debts]] — debts / liabilities and interest maths
- [[money-events]] — money events + upcoming payments (unified events timeline)
- [[goals]] — financial goals and progress
- [[members-and-permissions]] — roles, permissions, invites
- [[households-and-onboarding]] — household creation & onboarding
- [[dashboard]] — overview / status buckets
- [[snapshots-and-networth]] — net-worth history & attention items
- [[market-data]] — market prices & FX reference data
- [[settings-and-sharing]] — household config, reminders, sharing levels
- [[auth]] — authentication & session gating

## Source-of-truth docs

- **The backend Prisma schema (`backend/prisma/schema.prisma`) is the source of
  truth for the DB.** The old `frontend-web/supabase/migrations/*.sql` file is
  legacy/reference only — do NOT treat it as canonical.
- `# Product Spec v1.md` and `# Backend Tables & Relationships — Money.md`
  (frontend-web repo root) are the authoritative DOMAIN-RULES references, kept in
  sync with the Prisma schema.
- **Authorization is app-layer** (NestJS guards), NOT Postgres RLS — the project
  stays DB-portable. See [[members-and-permissions]].

# Money events & upcoming payments (Events feature)

The central ledger. Recorded financial events **and** upcoming payments live in one unified timeline. The old standalone Payments page now **redirects to `/events`**. Related: [[assets]], [[debts]], [[goals]], [[dashboard]].

## Overview

Two record source types unified into `FinancialRecordItem`:
- `upcoming_payment` — planned.
- `money_event` — actual, the central transaction log.

`MoneyEvent` fields: title, type, category, amount, currency, eventDate, direction, and optional links to fromAsset, toAsset, upcomingPayment, debt, financialGoal, snapshot.

**`category` is a free-form CODE**, not a Postgres enum — backed by the
`money_event_categories` table (seeded system rows with `household_id IS NULL` +
per-household custom rows). Adding a category is a data insert, not a migration.
Existence is validated at the service layer; `normalizeMoneyEventCategory` keeps
any non-empty code (falls back to `other` only when blank). The `interest` code
(saving-deposit interest events) is a seeded system category — the old enum
omitted it, so it was silently rewritten to `other` (fixed). System seed list:
`SYSTEM_MONEY_EVENT_CATEGORIES` in `money-space.mapper.ts`.

## Direction derivation (`deriveDirection` / `getDirectionFromEventType`)

Auto-derived from event type unless explicitly overridden (explicit wins):
- income → `inflow`
- expense, payment_paid, debt_update → `outflow`
- adjustment → `neutral`
- else → `neutral`

`adjustment` (already in the Postgres enum + `schema.prisma`; added to the backend TS `MoneyEventType` union) is used by a debt **balance reconcile** ([[debts]]): a neutral, debt-linked bookkeeping event that records the outstanding delta **without moving a wallet or auto-reducing the debt** (both are outflow-gated). An additional disbursement instead reuses `debt_update` with explicit `direction: 'inflow'`.

## Per-event-type link rules (`.superRefine` in `buildActualSchema`)

- **Requires a source asset** (`eventRequiresFromAsset`): expense, transfer, payment_paid, goal_contribution, asset_purchase, asset_sale.
- **Requires a destination asset** (`eventRequiresToAsset`): income, transfer, asset_purchase, asset_sale.
- **from ≠ to** for transfer / asset_purchase / asset_sale.
- `payment_paid` **must link** to an upcoming payment.
- `goal_contribution` **must link** to a goal.
- Amount must be **> 0**.

### goal_contribution requires a wallet source (and debits it)

A `goal_contribution` moves cash from a spendable wallet **into a savings goal**
([[goals]]). Its `fromAssetId` is **mandatory** and must be a `cash` /
`bank_account` asset — `MoneyEventsService.assertGoalContributionSource` rejects a
missing / non-wallet source with a **400** on both create and update, before any
balance moves. `applyWalletEffects` then **debits** that wallet by the amount
(direction stays **neutral** — see the summary rule below — so it debits the
pocket without counting as spending, exactly like a transfer between the
household's own wallets). This closes the old bug where a `goal_contribution`
with no source raised progress without any money leaving a wallet. The source is
chosen **per contribution** (the goals quick-add row's required wallet picker) —
the goal itself stores no source wallet. See [[goals]].

### Wallet-only link rule (income / expense / transfer)

For **income, expense, transfer** every linked asset (`fromAssetId` and, where
present, `toAssetId`) must be a spendable **wallet** — `cash` or `bank_account`
only. Money can only flow in or out of a free cash balance; a valued asset
(gold, stock, saving deposit, …) changes hands through its own flow (sell /
revalue), never a generic cash move.

- **Backend** (`MoneyEventsService.assertWalletLinks`, gated by
  `WALLET_ONLY_EVENT_TYPES = {income, expense, transfer}`) rejects a non-wallet
  source/destination with a **400** — checked up front on both create and update,
  before any wallet balance is touched. Reuses `AssetsService.assertWalletAsset`.
- **Frontend** enforces it in the UI too: the events forms build a
  `sourceAssetOptions` list (assets filtered to cash / bank_account) and use it
  for the "nguồn tiền" source select **and** the income/transfer destination
  select; only goal_contribution's destination still lists all assets.
- **`asset_sale` is the exception**: its `fromAssetId` is the *sold* asset (a
  non-wallet — gold, stock, …), so it is deliberately excluded from the rule. The
  sold asset is **view-only** — an asset_sale edits through the dedicated
  `AssetSaleDialog`, where the sold asset is fixed context (shown in the header,
  never a form field), so the source can be seen but never changed.

## Monthly summary (thu / chi / net) — backend is source of truth

`GET /api/households/:householdId/money-events/summary?month=YYYY-MM` →
`{ householdId, month, recordedCount, totalIncome, totalOutcome, netChange }`,
computed by `MoneyEventsService.getMoneyEventsSummary`. **The frontend must NOT
re-derive these totals from the event list** — it reads them from this endpoint.

- Filters events to `isoDate.startsWith(month)` (month defaults to `AS_OF`'s
  month when omitted).
- **Only `inflow` / `outflow` count** toward thu/chi; `neutral` events
  (asset_update, transfer, goal_contribution, sale bookkeeping) are excluded —
  same rule as `deriveDirection`. Summed by `direction` on `Math.abs(amount)`;
  `netChange = totalIncome − totalOutcome`. Note: a `neutral` event can still
  **move a wallet balance** (a transfer, and now a goal_contribution, debit a
  wallet) — "neutral" means it doesn't change the household's total money (it
  moves between its own pockets), so it must not show as thu/chi even though a
  wallet balance changed.
- Route is declared **before** `:eventId` so "summary" isn't captured as an id.
- Frontend: `useEventsSummary` (query key `…, 'events', 'summary', month`) feeds
  the events page summary card. Event create/update/delete invalidate the whole
  `['households', id, 'events']` prefix so both list and summary refetch.
  upcoming-in-7-days and attention counts stay client-derived (payment /
  attention concerns the summary endpoint doesn't cover).

## Upcoming payments

- `UpcomingPayment`: name, amount, dueDate, frequency, `autoCreateNext` flag, owner member, optional `debtId` link, status, attention level/flag.
- **Payment status state machine** (`PaymentStatus`): unpaid → paid / pending_confirmation / postponed / overdue.
- **Status derivation** (`getPaymentRecordStatus`): past due date → `overdue`; pending → `pending_confirmation`; else `unpaid`.
- **Recurring rule** (`buildUpcomingSchema`): `autoCreateNext` can only be enabled when `frequency ≠ once`. Recording a payment captures `paidAt`, `paidBy`, `paidAmount`, `paidFromAssetId`.

## A money event moves its linked wallets (side effect of create/update/delete)

Creating a money event **moves the money it represents between its linked wallets**, in the same transaction as the event write (both land or roll back). `MoneyEventsService.applyWalletEffects`:

- **create** → debit `fromAssetId`, credit `toAssetId` by `amount`.
- **update** → reverse the *old* event's moves, then apply the *new* one's (handles amount or wallet changes).
- **delete** → reverse the event's moves (credit back `fromAsset`, debit `toAsset`).

**Only wallet assets move**: `credit/debitManualAsset` no-op unless the asset's `type` is `cash` or `bank_account` (`WALLET_ASSET_TYPES` in [[assets]]). A market-priced / formula asset is valued from its price/formula, not by adding cash — so an event linking such an asset (or a missing link) simply doesn't move it. A debit **floors at 0** — spending more than a wallet holds drives it to 0, never negative. `fromAssetId`/`toAssetId` are still stored on every event regardless of asset type; only the balance move is wallet-gated.

**Wallet effects hold the transaction's one connection for many round-trips**: each `credit/debitManualAsset` chains `ensureAsset` (2 reads) → `updateAsset` → `upsertCurrentValuation` (price/FX + valuation read/insert/update ≈ 5 more), so a single create with both wallets is ~15-20 sequential statements, and update (reverse + re-apply) roughly doubles that. `createMoneyEvent`, `updateMoneyEvent`, `deleteMoneyEvent`, and the per-period `accrueSavingInterestForAsset` therefore run their `runInTransaction` with a raised **`timeout: 30000`** (`maxWait: 10000`), not the 5s default — otherwise the interactive transaction can abort mid-write ("Transaction not found") and strand its connection on the pooler.

**Debts route their wallet moves through here now**: `createDebt` logs the borrow inflow via `createMoneyEvent` (which credits the received-to wallet) and no longer calls `creditManualAsset` itself; `deleteDebt` calls `MoneyEventsService.deleteMoneyEventsByDebt` — which **bulk soft-deletes all the debt's event rows in one `updateMany`**, then loops them to reverse each one's wallet move (per-event, since each moves different wallets) — instead of a manual `debitManualAsset`. See [[debts]].

**Wallet is credited NET of fee**: `applyWalletEffects` moves `amount − feeAmount`, not `amount`. `feeAmount` is a `money_events` column that is 0 for every event type except `asset_sale` (and later `asset_purchase`), so this changes nothing for other events. For a sale the gross proceeds are `amount`, the fee never reaches the account, and the wallet rises by the net.

## An asset_sale also reduces the sold asset (side effect of create/update/delete)

An `asset_sale` event, beyond crediting the receiving wallet net, reduces the **sold** asset's position via `MoneyEventsService.applySaleEffects` → `AssetsService.sellPosition` (and `reverseSaleEffects` → `reverseSalePosition` on edit/delete), in the same transaction:

- Market asset (has a live `marketPosition`) → decrement `quantity` by `soldQuantity`.
- Manual asset (`real_estate` / `investment`) → reduce stored value by `soldValue`.
- Full sale (remaining ≤ 0) → `status = 'sold'`, `soldAt = eventDate`, value 0. The asset row is kept, not deleted.

`money_events.soldQuantity` / `soldValue` persist exactly what left the position so edit/cancel restores it precisely. Full details, rationale, and the `direction = neutral` reasoning: [[asset-sale]].

## Recording a repayment reduces the linked debt (side effect of `createMoneyEvent`)

When a money event is created that both **links to a debt** (`debtId` set) **and** is an **outflow** (a repayment — e.g. marking a "Tra no: ..." upcoming payment as paid, which is a `payment_paid` outflow), `MoneyEventsService.createMoneyEvent` decrements that debt's `outstandingAmount` by the event's `amount`, in the **same transaction** as the event insert (both land or roll back together). The decrement is floored at 0 in-statement (`GREATEST(0, outstanding_amount - amount)`, `reduceDebtOutstanding`), so overpaying settles the debt rather than going negative.

**The borrow inflow is excluded**: `createDebt` logs a `debt_update` event with explicit `direction: 'inflow'` linked to the debt — that raises the wallet and must NOT pay the debt down, so the outflow-only guard skips it.

**Frontend must pass `debtId`**: the mark-paid flow copies the paid upcoming payment's `debtId` into the `payment_paid` event payload, and the events mutations invalidate the **debts** query (as well as events + dashboard) so the debts view reflects the new outstanding. Asymmetry note: deleting a repayment event does **not** currently restore the debt outstanding (there is no un-pay flow).

## Timeline grouping (`getTimelineGroupKey`)

Upcoming payments → "upcoming"; else by date → today / this-week / this-month / older. Week is Mon–Sun. Uses hardcoded `TODAY = '2026-07-08'` (see [[domain-overview]]).

## Attention rule (`isAttentionRecord`)

Flagged if `isAttentionNeeded`, OR level important/urgent, OR status overdue / pending_confirmation / postponed.

## Where it lives in code

- **frontend-web**: `src/features/events/{model/events.ts, model/events.types.ts, model/events-form.ts, model/events-month.ts, api/events.repository.ts, hooks/...}`. Legacy: `src/features/payments/model/` (due-bucket logic `PaymentGroupKey = overdue|next7|next30|later`).
- **backend**: `src/modules/money-events/`, `src/modules/payments/` (separate modules).
- **mobile-app**: to be ported.

## Enums

`RecordType` (10 event types: expense, income, transfer, asset_purchase, asset_sale, asset_update, payment_paid, goal_contribution, debt_update, adjustment/other), `RecordDirection = inflow | outflow | neutral`, `RecordStatus = unpaid | paid | overdue | recorded | pending_confirmation | postponed`, `MoneyEventStatus = recorded | pending_confirmation | cancelled`, `frequency = once | weekly | monthly | quarterly | yearly`, `AttentionLevel = normal | important | urgent`.

# Money events (Events feature)

The central ledger: **money that has already moved**. The old standalone
Payments page **redirects to `/events`**. Related: [[assets]], [[debts]],
[[goals]], [[dashboard]], [[cashflow-events]].

> **v3.1 status — shim removed.** "Upcoming payments" are now **cashflow
> events** ([[cashflow-events]]); the `upcoming_payments` model and its API are
> gone. The transitional compat shim (`use-payments-compat.ts` +
> `legacy-payment-shim.ts`) has been **deleted**, along with the
> `upcoming_record-form`. `/events` and `/debts` now read `CashflowEvent`
> directly.

## The ledger / forecast split

`/events` shows **recorded** movements. `/upcoming` shows **expected** ones and
owns their whole lifecycle (complete / postpone / cancel). The two are never
merged into one timeline — a forecast row and a recorded row are different
kinds of fact, and mixing them was what the shim forced.

Consequences the client must respect:

- `FinancialRecordItem` has **no `sourceType`** — every row is a money event.
- `/events` has **no "upcoming" tab** and no create/edit form for expected
  money. Its quick-action picker keeps an "upcoming" entry that **navigates to
  `/upcoming`** (like `debt_borrow` → `/networth`), rather than writing one.
- Marking an expected payment as paid happens on `/upcoming` via
  `POST …/complete`. The old `/events` "mark paid" flow — create a money event,
  then **DELETE** the payment — was wrong twice over: it bypassed the
  server-side completion transaction, and for a recurring event it destroyed
  the whole series instead of advancing `expectedDate`.

`MoneyEvent` fields: type, category, amount, currency, eventDate, direction,
`note` (description), and optional links to fromAsset, toAsset, cashflowEvent,
debt, snapshot. (No goal link — see below.)

**`cashflowEventId`** (formerly `upcomingPaymentId`, now renamed client-side to
match the backend) records which expected movement this event settled. The
backend DTO accepts both spellings and prefers `cashflowEventId`. It is
deliberately **not copied when duplicating** an event — only one money event can
settle a given cashflow event.

**No `title` field.** The free-text `title` was dropped from money events — the
**note** is now the descriptive label and `category` is the classification. The
record form no longer has a "Nội dung" field; the note carries the description
(the form auto-fills a sensible note for transfer /
payment_paid when the user leaves it blank, e.g. `Chuyển từ … sang …`, `Đã trả
…`). Everywhere the UI used to show `title` (events timeline / `record-card` /
data table, dashboard recents, debt & asset history rows) it now shows the note,
falling back to the translated category label when the note is empty. The
timeline's `FinancialRecordItem` keeps a derived `title` (note-or-category)
purely as the display label — it is not a stored event field.

**`category` is REQUIRED and a free-form CODE**, not a fixed enum — backed by the
`money_event_categories` table (seeded system rows with `household_id IS NULL` +
per-household custom rows). Adding a category is a data insert, not a schema
change. It is mandatory: the record form requires the "Danh mục" picker for
expense/income (`buildActualSchema` superRefine — the auto-classified types
derive it), and the backend rejects a blank category with a 400.
`normalizeMoneyEventCategory` keeps any non-empty code (falls back to `other`
only for internal auto-classified flows). The `interest` code
(saving-deposit interest events) is a seeded system category — the old enum
omitted it, so it was silently rewritten to `other` (fixed).

**Category UI (not free-text).** The record form's "Danh mục" field is a
`<Select>` bound to the category **code**, sourced from the
`money_event_categories` table via `useEventCategories` → `categoryOptions` in
`use-events-page.ts` (system rows + this household's custom rows). The **display
label always follows the user's language via the code**:
`t('options.eventCategory.<code>', { defaultValue: dbLabel })` — the DB `label` is
only a fallback for custom codes with no i18n key. Households manage their own
categories (add / edit label / delete) from the **Settings page**
(`settings/ui/components/categories-card.tsx`); system rows are read-only. Backend
CRUD lives at `/api/households/:id/money-event-categories`
(GET = any member, POST/PATCH/DELETE = `edit` capability). The **code is
immutable** on update — renaming would orphan events pointing at it; create a new
category and re-tag instead.

**Default category (`isDefault`).** A household can mark **one** category as its
default; the create form auto-selects it (`defaultCategoryCode` memo in
`use-events-page.ts` prefills `category` on the create reset). Each
`EventCategoryItem` carries `isDefault` (computed by the backend from the
household's config pointer — works for system OR custom codes; see backend
memory). The Settings → Categories card (`categories-card.tsx`) shows a **star
toggle** per row: clicking sets that code as default (clearing the previous),
clicking the current default clears it — via `PUT
/money-event-categories/default` with `{ code }` / `{ code: null }`
(`setDefaultEventCategory` → `useEventCategories().setDefaultCategory`).

## Direction derivation (`deriveDirection` / `getDirectionFromEventType`)

Auto-derived from event type unless explicitly overridden (explicit wins):

- income → `inflow`
- expense, payment_paid, debt_update → `outflow`
- adjustment → `neutral`
- else → `neutral`

`adjustment` is used by a debt **balance reconcile** ([[debts]]): a neutral,
debt-linked bookkeeping event that records the outstanding delta **without moving
a wallet or auto-reducing the debt** (both are outflow-gated). An additional
disbursement instead reuses `debt_update` with explicit `direction: 'inflow'`.

## Per-event-type link rules (`.superRefine` in `buildActualSchema`)

- **Requires a source asset** (`eventRequiresFromAsset`): expense, transfer, payment_paid, asset_purchase, asset_sale.
- **Requires a destination asset** (`eventRequiresToAsset`): income, transfer, asset_purchase, asset_sale.
- **from ≠ to** for transfer / asset_purchase / asset_sale.
- Amount must be **> 0**.

### `asset_purchase` — two shapes, one row

An `asset_purchase` says how a holding came to exist, and its `from_asset_id`
decides which act it records (see [[assets]]):

- **With a funding wallet** — a real purchase: `direction: 'outflow'`,
  `from_asset_id` = the wallet, `to_asset_id` = the asset. The wallet is debited
  by the cost basis, so **net worth does not move**.
- **Without one** — the household is declaring something it already owns:
  `direction: 'neutral'`, no source, no wallet touched. Net worth rises, which
  is correct: nothing moved, the app simply learned about it.

The second shape used to be the ONLY shape, which is how buying 100tr of gold
appeared to create 100tr from nothing.

`asset_purchase` is written by the assets flow (create / add to a position), not
through the generic record form, and it stays outside `WALLET_ONLY_EVENT_TYPES`
because its destination is deliberately a non-wallet asset. The events page
offers **"Mua tài sản"** next to "Bán tài sản"; both hand over to the asset
feature rather than writing the row inline.

### Goals are not linked to money events at all

A goal is a set of shares of real assets ([[goals]]), so its progress follows
those assets. There is no `goal_contribution` event type, no goal picker on the
record form, and no `financialGoalId` on a money event — the enum value and the
column link were both removed.

Money "leaves a goal" by being spent from the asset behind it: the expense
debits the wallet as usual and the goal reports less on the next read, because a
fixed share is capped at its asset's live value. Nothing goal-side is written.

The events timeline's "Mục tiêu" tab went with it — no event could ever land
there again.

### Wallet-only link rule (income / expense / transfer)

For **income, expense, transfer** every linked asset (source `fromAssetId` and,
where present, destination `toAssetId`) must be a spendable **wallet** — `cash`
or `bank_account` only. Money only flows in/out of a free cash balance; a valued
asset (gold, stock, saving deposit, …) changes hands through its own flow (sell /
revalue), never a generic cash move.

- **Frontend**: `useEventsPage` builds `sourceAssetOptions` (assets filtered to
  cash / bank_account) alongside the full `assetOptions`. The events forms use
  `sourceAssetOptions` for the "nguồn tiền" source select (`fromAssetId`,
  `expectedFromAssetId`) **and** the income/transfer destination select
  (`toAssetId`). Default source/destination selection seeds from the same list.
- **Backend** enforces the same as a **400** (`assertWalletLinks`, gated by
  `WALLET_ONLY_EVENT_TYPES = {income, expense, transfer}`) on create + update.
- **`asset_sale` is the exception**: its `fromAssetId` is the _sold_ asset (a
  non-wallet), so it is excluded. The sold asset is **view-only** — asset_sale
  edits via the dedicated `AssetSaleDialog`, where the sold asset is fixed
  context (header only, never a form field), so it can be seen but not changed.

## Monthly summary (thu / chi / net) — backend is source of truth

The events page summary card's **Tổng thu / Tổng chi / Net** come from the
backend, **not** re-computed on the client. `useEventsSummary` calls
`GET /api/households/:householdId/money-events/summary?month=YYYY-MM` →
`{ recordedCount, totalIncome, totalOutcome, netChange }`.

- Only `inflow` / `outflow` events count; `neutral` (asset_update, transfer,
  sale bookkeeping) are excluded server-side. A `neutral`
  event can still move a wallet balance (a transfer moves money between the
  household's own pockets) — neutral means it doesn't change the household's
  total money, so it stays out of thu/chi even when a balance changed. A
- `use-events-page` feeds these into the `summary` object (defaults to 0 while
  loading). `attentionCount` stays client-derived from the timeline list (the
  summary endpoint doesn't cover it). The upcoming-in-30-days figures were
  removed — expected money belongs to `/upcoming`.
- Query key `['households', id, 'events', 'summary', month]`. Event
  create/update/delete invalidate the `['households', id, 'events']` prefix so
  both the list and the summary refetch.

## Upcoming payments — moved out

Expected movements are **cashflow events** and live entirely in
[[cashflow-events]] / `/upcoming`. The `UpcomingPayment` model, its status state
machine, and the `/events` upcoming form are gone; nothing on this page creates
or edits money that has not moved yet.

## Recording a repayment reduces the linked debt

Marking a debt-linked upcoming payment as paid ("Đánh dấu đã trả" on a "Tra no: ..." reminder) must reduce that debt's remaining balance:

- **Frontend**: completing a debt-linked cashflow event on `/upcoming`
  (`POST …/complete`) is what records the repayment — the backend creates the
  money event carrying the `debtId`. On `/events`, `onSubmitActual` only
  preserves an existing `debtId` when **editing** an already-recorded
  repayment; it no longer sources one from a payment being marked paid.
- **Cache**: `useEvents` create/update/delete mutations invalidate the **debts** query (plus events + dashboard) so the debts view refetches the new outstanding.
- **Where the balance actually changes**: the **backend** decrements `outstandingAmount` by the event amount, floored at 0, in the same transaction as the event insert — only for debt-linked **outflow** events (the borrow inflow is excluded). See [[debts]] and the backend memory. The frontend does not compute the new outstanding itself.

## Selling an asset (`asset_sale`)

A sale is a single `asset_sale` money event (`direction = neutral`), created from the assets-list "Bán" action (primary) or the events quick-action "Bán tài sản" (secondary, navigates to `/assets`). The frontend posts: `amount` = gross proceeds, `feeAmount` = fee, `fromAssetId` = sold asset, `toAssetId` = receiving wallet, plus `soldQuantity` (market assets) / `soldValue` (manual assets — the resolved amount that left the position; a "bán toàn bộ" sends the current quantity/value). The **backend** credits the wallet net (`amount − feeAmount`), reduces the sold asset's position, and on a full sale sets the asset `status = 'sold'`. The events mutations invalidate the **assets** query so the reduced position/status shows. Full rules: [[asset-sale]].

## Who recorded it (`createdById`)

Every money event carries `createdById` — the auth **profile id** of whoever recorded it. The API sends **no name**: resolve it against the household's members via `MemberItem.profileId` (`useMembers`). A creator who has left the household therefore goes unnamed ("Không rõ") instead of being shown under a stale name. Rendered today as the "Người ghi" column in the goal detail contribution history.

Not trustworthy for **system-generated** events (saving-interest accrual): those have no acting member and the backend falls back to the household creator, because the column is NOT NULL. Don't build a UI that asserts who did something on an event a person did not record. See the backend's [[money-events]] for the write rule.

## Timeline grouping (`getTimelineGroupKey`)

Upcoming payments → "upcoming"; else by date → today / this-week / this-month / older. Week is Mon–Sun. Uses hardcoded `TODAY = '2026-07-08'` (see [[domain-overview]]).

## Attention rule (`isAttentionRecord`)

Flagged if `isAttentionNeeded`, OR level important/urgent, OR status overdue / pending_confirmation / postponed.

## Where it lives in code

- **frontend-web**: `src/features/events/{model/events.ts, model/events.types.ts, model/events-form.ts, model/events-month.ts, api/events.repository.ts, hooks/...}`. Legacy: `src/features/payments/model/` (due-bucket logic `PaymentGroupKey = overdue|next7|next30|later`).
- **backend**: `src/modules/money-events/`, `src/modules/payments/` (separate modules).
- **mobile-app**: to be ported.

## Enums

`RecordType` (9 event types: expense, income, transfer, asset_purchase, asset_sale, asset_update, payment_paid, debt_update, adjustment/other), `RecordDirection = inflow | outflow | neutral`, `RecordStatus = unpaid | paid | overdue | recorded | pending_confirmation | postponed`, `MoneyEventStatus = recorded | pending_confirmation | cancelled`, `frequency = once | weekly | monthly | quarterly | yearly`, `AttentionLevel = normal | important | urgent`.

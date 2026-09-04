# Cashflow events

Expected future movements of money — the **sole input to the forecast**.
Replaces `upcoming_payments`. Related: [[money-events]], [[debts]],
[[snapshots-and-networth]], [[sharing-levels]], [[goals]].

A live outgoing event also lowers the wallet it settles from **before it is
completed**, for every screen that reports goal money: the forecast hero, the
warning shown before an outflow is saved, and the running month's contribution
(`walletValuesAfterPendingOutflows`). A scheduled outflow is a decision already
made, so the money behind it is not counted as available to a goal. See
[[goals]].

## Overview

A cashflow event is one expected movement of money in **either direction**, on a
date, with how sure it is and whether it is an obligation. The old
`upcoming_payments` table could only express money going *out*, which is why the
product had no running balance, no lowest-projected-balance, and no flexible
money.

Spec v3.1 §2.9 explicitly rejects a separate `upcoming_incomes` table: incoming
and outgoing belong on **one timeline**, because the whole point is to see them
interleaved day by day.

**`category_id`** is a real FK to `money_event_categories`, exactly like
`money_events.category_id` — one table, one vocabulary, for both the expected
side and the recorded side. It is NOT NULL; omitting it on create resolves the
system `other` category rather than storing a literal. See [[money-events]] for
the category table itself (code generation, icon/colour, default, and why the
FK targets `id` rather than `code`).

A category did not exist on this table at all before migration
`20260903100000_category_icon_key_and_cashflow_category` — every cashflow event
was uncategorized, and completing an **outgoing** one hardcoded `other` on the
money event it created regardless. That migration added it as a TEXT code;
`20260904090000_category_id_foreign_key` then converted it to the FK.

## The four axes

| field | values | what it decides |
|---|---|---|
| `direction` | `incoming` \| `outgoing` | which way the balance moves |
| `requirement` | `required` \| `planned` \| `null` | whether it counts toward **obligation coverage**. `planned` money still leaves the account (it moves the running balance) but not spending it doesn't make the household "not covered". `null` for incoming — nothing obliges money to arrive |
| `certainty` | `confirmed` \| `estimated` | the forecast **banks only `confirmed` incoming**. `estimated` is displayed but never silently treated as certain — this is what keeps the forecast conservative |
| `status` | `expected` \| `completed` \| `pending_confirmation` \| `postponed` \| `overdue` \| `cancelled` | `completed`/`cancelled` owe nothing. `postponed` is shown on the timeline but **excluded from the balance** — its date is no longer trusted |

Validation (`assertValid`): outgoing must have a requirement (defaults to
`required` — the conservative choice); incoming is forced to `null`;
`recurrenceEndDate >= expectedDate`. (The rule that a `private` event must name its
`privacyOwnerMemberId` (§30 — `created_by` is not a valid substitute for a new
record).

## Recurrence: one row, virtual occurrences

**A recurring event is ONE record.** `expectedDate` is the *current* occurrence
and `recurrence` is the rule. The forecast expands future occurrences
**virtually**; occurrence rows are never pre-created (§2.15). That is why
`auto_create_next` is gone.

`src/common/utils/recurrence.ts` is the single implementation, used by **both**
the forecast (expanding a horizon) and the completion action (advancing the
date). If those ever diverged, completing an event would move it somewhere the
forecast didn't predict.

Two behaviours worth knowing:

- **Steps are measured from the original date**, never iteratively. Stepping
  Jan 31 twice one-at-a-time gives Feb 28 → Mar 28, permanently losing the 31st.
  From the origin it's Mar 31, which is what "monthly on the 31st" means.
- **Overdue occurrences are clamped onto `asOfDate`, and only ONE is.** An
  unpaid bill still has to come out of today's cash — but a monthly series
  nobody has completed for a year must not emit twelve phantom charges and make
  the forecast look catastrophic. All past steps collapse into a single clamped
  occurrence flagged `wasClampedFromPast`.

`MAX_OCCURRENCES_PER_EVENT = 400` guards against a corrupt row spinning forever.

## Completing an event (§18)

`POST /cashflow-events/:id/complete`, one transaction:

1. **Idempotency guard** — refuses if already completed, or if the series has
   already moved past the occurrence being completed. Without it a double-tap
   creates two money events *and* advances a monthly series two months, silently
   dropping a month from the forecast.
1b. **A settling wallet is REQUIRED** (`assertSettlementAsset`). Resolution order
   is `payload.assetId` → the event's own `settlement_asset_id` → **400**. It
   must be `liquidity = usable_now` (flexible money — the household's own answer
   to "is this spendable", see [[assets]]) **and** a wallet type
   (`cash`/`bank_account`), because `debitManualAsset`/`creditManualAsset`
   return early for every other type.
   Why it is a hard error rather than a default: with no asset on either side
   `applyWalletEffects` debits and credits nothing, so the money event was
   written, the event left the overdue list looking settled, and **not one
   balance moved**. A completion that moves no money is worse than a rejection.
   `settlement_asset_id` is **required at create for outgoing** events
   (`assertValid`), and stays optional for incoming. It used to be optional on
   both — "at planning time the household often does not know which account a
   bill comes out of" — but an outflow now outranks the goals sharing its wallet
   and shrinks their money, so an outflow naming no wallet would either drain no
   goal (understating what it costs) or force a guess at which one. Asking at
   create is also what lets the form show the goal impact before saving. See
   [[forecast-and-flexible-money]].

   **Required at CREATE, nullable in the column.** Deleting the settling asset
   clears `settlement_asset_id` back to NULL (see [[assets]]) — the event is a
   fact about money that still has to move, so it survives its wallet. That
   leaves a live outgoing event with no wallet, which `assertValid` would refuse
   to create: legal, because the rule is about the moment of creating, not an
   invariant of the row. The edit form detects it (the stored id matches no
   wallet in the picker) and says the wallet was deleted, instead of rendering a
   blank select that reads as "none chosen" and silently rewrites the event on
   the next save.
2. **Create the money event via `MoneyEventsService.createMoneyEvent`** (never a
   raw insert), so wallet debit/credit, valuation points and the goal mirror all
   fire. `outgoing` → `payment_paid` debiting `fromAssetId`; `incoming` →
   `income` crediting `toAssetId`. Both carry `cashflowEventId` and the
   cashflow event's own `categoryId`. **`note` is exactly what the caller typed**
   (`payload.note?.trim() ?? ''`) — it must NOT fall back to the cashflow
   event's `name` when nothing was typed. It used to (`payload.note?.trim() ||
   event.name`), which made a completion with no note read as if someone had
   written the event's name as its description; the timeline already falls
   back to the category label for a record with no note (see
   [[money-events]]).
3. **Record `lastCompleted*`** — for a recurring series these describe the most
   recent completion, *not* a terminal state.
4. **Branch:**
   - `once` → `status = completed`, date untouched. Done.
   - recurring → **`expectedDate` advances** to the next occurrence and `status`
     stays `expected`. The record is a live series; the history lives in the
     money event just created. If the next occurrence is past
     `recurrenceEndDate`, the series closes and the date stays on the last real
     occurrence.

`postpone` moves the date and returns the event to `expected` (we have a
trustworthy date again). `cancel` sets `status = cancelled`.

## Debts generate cashflow events

`DebtsService.createRepaymentSchedule` emits one event per installment with
`direction: 'outgoing'`, `requirement: 'required'`, `certainty: 'confirmed'` —
the combination that makes a contractual repayment count toward obligation
coverage. Bulk-inserted in one round-trip to keep the debt-create transaction
short. See [[debts]].

### They are read-only outside the debt

A repayment reminder is **derived**, not authored: any change to the debt's
cadence, anchor, term or instalment amount deletes the still-open reminders
(`deleteOpenCashflowEventsByDebt`) and regenerates them. A hand edit would
therefore be silently reverted by the next debt edit, and a hand delete would
reappear.

So `assertNotDebtDerived` rejects (**409**) `updateCashflowEvent`,
`deleteCashflowEvent`, `postponeCashflowEvent` and `cancelCashflowEvent` for any
event carrying a `debtId` — **every** lender type, not just
`bank_institution`. Change the debt instead.

Two things are deliberately NOT blocked:

- **Completing** one. Recording that a payment happened is not an edit of the
  plan, and is the whole point of the reminder.
- The **debt-driven** paths (`updateOpenCashflowEventAmounts`,
  `deleteOpenCashflowEventsByDebt`), which reach the repository directly and are
  how the regeneration itself runs.

Do not confuse this with the money-events rule in [[debts]]: that one governs
*recorded* repayments (history, where `relative`/`other` stay editable and
rebalance the next instalment). This governs the *future reminders*.

The UI hides the actions rather than letting them fail — the forecast row and
the overdue row carry a `debt` marker saying why, on both web and mobile.

## Migration notes (from `upcoming_payments`)

Renames: `due_date` → `expected_date`, `frequency` → `recurrence`, `paid_*` →
`last_completed_*`. Status remap: `unpaid` → `expected`, `paid` → `completed`.
Backfill: every legacy row became `direction = 'outgoing'`, `certainty =
'confirmed'`, and `requirement = required` when debt-linked else `planned` (the
honest default — marking them all required would overstate obligations).

`money_events.upcoming_payment_id` → `cashflow_event_id`.

**The `/upcoming-payments` API was replaced, not aliased.** The payload shape
changed, so a silent alias would have handed clients data they'd misread.

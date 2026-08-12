# Cashflow events

Expected future movements of money — the **sole input to the forecast**.
Replaces `upcoming_payments`. Related: [[money-events]], [[debts]],
[[snapshots-and-networth]], [[shared-calculation-and-privacy]].

## Overview

A cashflow event is one expected movement of money in **either direction**, on a
date, with how sure it is and whether it is an obligation. The old
`upcoming_payments` table could only express money going *out*, which is why the
product had no running balance, no lowest-projected-balance, and no flexible
money.

Spec v3.1 §2.9 explicitly rejects a separate `upcoming_incomes` table: incoming
and outgoing belong on **one timeline**, because the whole point is to see them
interleaved day by day.

## The four axes

| field | values | what it decides |
|---|---|---|
| `direction` | `incoming` \| `outgoing` | which way the balance moves |
| `requirement` | `required` \| `planned` \| `null` | whether it counts toward **obligation coverage**. `planned` money still leaves the account (it moves the running balance) but not spending it doesn't make the household "not covered". `null` for incoming — nothing obliges money to arrive |
| `certainty` | `confirmed` \| `estimated` | the forecast **banks only `confirmed` incoming**. `estimated` is displayed but never silently treated as certain — this is what keeps the forecast conservative |
| `status` | `expected` \| `completed` \| `pending_confirmation` \| `postponed` \| `overdue` \| `cancelled` | `completed`/`cancelled` owe nothing. `postponed` is shown on the timeline but **excluded from the balance** — its date is no longer trusted |

Validation (`assertValid`): outgoing must have a requirement (defaults to
`required` — the conservative choice); incoming is forced to `null`;
`recurrenceEndDate >= expectedDate`; a `private` event must name its
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
2. **Create the money event via `MoneyEventsService.createMoneyEvent`** (never a
   raw insert), so wallet debit/credit, valuation points and the goal mirror all
   fire. `outgoing` → `payment_paid` debiting `fromAssetId`; `incoming` →
   `income` crediting `toAssetId`. Both carry `cashflowEventId`.
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

## Migration notes (from `upcoming_payments`)

Renames: `due_date` → `expected_date`, `frequency` → `recurrence`, `paid_*` →
`last_completed_*`. Status remap: `unpaid` → `expected`, `paid` → `completed`.
Backfill: every legacy row became `direction = 'outgoing'`, `certainty =
'confirmed'`, and `requirement = required` when debt-linked else `planned` (the
honest default — marking them all required would overstate obligations).

`money_events.upcoming_payment_id` → `cashflow_event_id`.

**The `/upcoming-payments` API was replaced, not aliased.** The payload shape
changed, so a silent alias would have handed clients data they'd misread.

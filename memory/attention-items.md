# Attention items

Signals worth the household's attention (spec §29). Related:
[[forecast-and-flexible-money]], [[cashflow-events]], [[data-freshness]],
[[money-events]], [[assets]].

## Every signal is derived

There is one kind of signal now: **derived**. A signal describes the household's
situation *right now* — a required payment is overdue, the projected balance dips
below zero, a wallet is overdrawn — and is recomputed on every read from the
forecast bundle. Nothing is ever written.

That is what makes them self-correcting: a signal appears the moment its
condition holds and disappears the moment it stops. There is no write to keep in
step, no row to go stale, and no code path that can forget to clean up.

| Rule code | Level | Related object |
|---|---|---|
| `cashflow_required_due_soon` | normal/important | cashflow event |
| `cashflow_overdue` | important | cashflow event |
| `low_projected_balance` | **urgent** | — |
| `goal_without_wallet` | important | financial goal |
| `wallet_overdrawn` | important | asset |
| `stale_data` | normal | asset |

`GET /attention-items` is the only route. It costs **no extra queries** — the
signals are computed from the forecast bundle already in memory.

## The `attention_items` table was dropped (2026-08-29)

It existed for the two things that genuinely cannot be recomputed: a hand-flagged
item, and a "don't show me this again" tombstone. **Neither was ever used.** The
table held zero rows in production and no client called the endpoints that wrote
to it, while every reader still had to merge an always-empty stored set and every
new signal had to answer "store or derive?" when the answer was always derive.

Dropped with it: the stored/seen/resolved/dismissed lifecycle, the dismissal
tombstones, `AttentionItemStatus`, and the `user_flagged` / `money_event_flagged`
/ `asset_moved_sharply` / `amount_over_threshold` rule codes.

**Kept**: `AttentionLevel` (still on `cashflow_events.attention_level`),
`RelatedObjectType` (the derived payload uses it), and
`snapshots.attention_count` — older snapshots keep the value that was true when
taken; new ones write 0.

If a hand-flagging feature is ever wanted, it needs a new home and a deliberate
design — do not restore this table by reflex.

## Why a flag on the ledger is the wrong shape

The recurring temptation is a boolean column (`money_events.is_attention_needed`,
dropped for this reason). It does not work, and the overdraft case shows why.

Whether an event sits on a negative balance is a property of the **wallet's
running balance at that point**, not of the event row. Editing a back-dated event
replays the wallet from its opening balance (see [[money-events]] and the
wallet-replay work), so correcting one amount can flip a dozen *untouched* events
between "fine" and "overdrawn". A stored flag would have to be rewritten across
every later event on every create, edit, delete, interest accrual and repayment —
and a missed branch is silent, permanent corruption with nothing to detect it.

Derived, the same question is `assets.value < 0` at read time. No writes, no
branches to miss.

## Rules that need care

- **`wallet_overdrawn` reads the wallet's current value**, off the asset list the
  forecast already loaded. It relies on the fact that **only a wallet can hold a
  negative value** — a market position is quantity × price, a property is a
  valuation — so no asset-type lookup is needed. `important`, not `urgent`:
  nothing is being lost right now and no date is being missed; the figures are
  describing money that was never there. It means a receipt is missing or an
  expense is wrong.
- **`goal_without_wallet`** reads the allocation's **`role`**, not the asset's
  type — the same field the asset-delete warning checks, so the two can never
  disagree about whether a goal "has a wallet". See [[goals]] and [[assets]]. A
  goal with **no allocations at all** raises nothing: that is "nothing chosen
  yet", a different situation from "the wallet went away".
- **Only `required` outgoing money raises a signal.** A `planned` purchase is a
  choice; the household has not failed at anything by not spending money they
  merely intended to. Treating a plan like an obligation is the nagging §29
  forbids.
- **Check `wasClampedFromPast` BEFORE the due-soon window.** The forecast clamps
  an overdue occurrence onto today, so its `date` reads as today — without that
  check every overdue bill would report as "due in 0 days".
- **A recurring series collapses to ONE signal**, keyed on the source event.
  Monthly rent inside a 90-day horizon must not produce three copies of one fact.
- **`stale_data` is measured against the household's OWN cadence.** A household
  on `manual` never goes stale — see [[data-freshness]].

## No prose, ever

Signals carry `ruleCode` + `params` and no text. The client owns all copy (hard
i18n mandate), and §29's calm-tone rules are a copy concern — a backend-rendered
"Khẩn cấp" can be neither translated nor softened. `level` is likewise a code
(`normal | important | urgent`).

## Derived ids

`derived:<ruleCode>:<scope>`, where scope is the related object or `household`.
Synthetic keys, not addressable resources. They no longer gate dismissals (there
are none), but they stay stable across recomputation so a client can key a list
on them without rows jumping between reads.

## No cron

Everything is computed on read, so there is no scheduler, no advisory locking,
and no duplicate-run problem on a multi-instance deployment.

## Where it lives in code

- **backend**: `src/modules/attention/` — `domain/attention-rules.ts` (pure, the
  unit-test surface) and `attention.service.ts` (loads the bundle, derives, sorts
  by urgency). The repository holds nothing but `assertHousehold`.
- **frontend**: `packages/core/src/features/dashboard/` reads the list. Neither
  client renders it yet — only `attentionCount` is consumed, and the dashboard
  payload reports 0 there because that endpoint deliberately runs no forecast.

## Route

```
GET /households/:hid/attention-items   → { householdId, items, total }
```

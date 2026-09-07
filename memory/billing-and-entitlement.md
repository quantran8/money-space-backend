# Billing and entitlement

What a household is allowed to do, and what it paid to get there. Related:
[[attention-items]], [[data-export]], [[households-and-onboarding]],
[[market-data]].

> Written during Phase 5. Phases 1–4 shipped the code without this file; the
> reasoning below is recovered from the code and from
> `session/2026-09-07/`, which holds the per-phase working records.

## Overview

Two tiers, priced per household — both people, never per seat:

```
39.000đ / tháng     299.000đ / năm     699.000đ trọn đời
```

**Free**: 2 active goals · 5 what-ifs/month · 2 auto-priced assets · 7/30-day
horizon · 3 months of history · 14-day trial on signup.

**Never gated**: inviting a partner, sharing levels, the activity log, the
what-if asset-sale funding step, and recording gold/stocks/crypto on the balance
sheet. The first three are the core loop — a one-person household is a dead end
— and the last is what a Vietnamese household opens the app for. What Premium
sells is **automation and decisions**, not the right to keep records.

Prices are constants in `constants/plan-catalog.ts` (changing one deserves a
review); discounts and the lifetime on/off switch are env config in
`config/billing.config.ts`, so a campaign is not a deploy.

## Resolving an entitlement

`resolveEntitlement(householdId, row, now)` is pure, and everything reads
through `EntitlementService`.

What is cached is the stored **row**, never the resolved answer. The comparison
against `now` runs on every call. That is what lets the cache live 15 minutes
without anyone getting 15 minutes of Premium they no longer have.

Three encodings worth knowing, all decided by `tier` + `currentPeriodEnd`:

| `tier` | `currentPeriodEnd` | Meaning |
|---|---|---|
| `free` | `NULL` | never purchased |
| `premium` | `NULL` | **lifetime** |
| `premium` | a date | expires then |

A missing row and `tier: 'free'` are the same thing, which is why no migration
had to backfill existing households.

**A lapsed plan keeps `tier: premium` and only moves `status`.** It lets the UI
say "hết hạn ngày 3" instead of "gia đình đang dùng gói Free" — the difference
between a win-back and a shrug. What the household may *do* comes from `limits`,
which has already dropped to Free.

## Enforcement, in two halves

- **Boolean features** (`forecast_horizon_extended`, `history_full`,
  `export_data`) — `@RequirePremium()` + `EntitlementGuard`, registered
  globally. It returns `true` immediately for a route with no decorator, so
  almost every request pays one `Reflector` lookup and nothing else.
- **Counted quotas** (`goals`, `whatIfPerMonth`, `marketPricedAssets`) — checked
  in the service via `assertQuota()`. A guard runs before the handler and cannot
  count without a second query the service is about to make anyway.

`null` in `PLAN_LIMITS` means unlimited, **never zero**.

## Showing a quota before it is hit

Two hooks, and the split matters:

- `usePremiumAction.check()` — decides whether an action may proceed, and
  **opens the paywall as a side effect**. Right on click, wrong during render.
- `useQuota(quota)` — reads only. This is what a screen uses to say "còn 1
  lượt". It returns `null` for premium, for an unlimited ceiling, and while the
  entitlement loads, so nothing is drawn until the answer is known.

Screens show the count **only at the ceiling** (`isLastOne` / `isExhausted`).
Counting from 1/5 on an empty page turns a tool for thinking into a meter,
which is the opposite of what what-if is for.

`usage` rides only on `GET /entitlement`, and `useWhatIf` invalidates that key
`onSettled` — a run that was refused is exactly when the number on screen is
most wrong.

### A what-if re-run spends another slot

`forecast.service.ts` consumes a slot on **every** successful run, including the
re-run that adds an asset sale and the one that removes it. So a single question
explored through the funding step can cost three of five.

That is defensible — each run is a real engine execution against a freshly
loaded bundle — but it is invisible to the household, and it became visible the
moment the UI started counting. Worth revisiting if the funding step turns out
to be where the free quota actually goes; the fix would be to charge per
question rather than per execution, which needs a scenario id the API does not
have today.

## Granting

`SubscriptionService.grantOrExtend` is the only writer of
`household_subscriptions`. Codes, payments, manual grants and the signup trial
all come through it, so the stacking rules exist once and the entitlement cache
is dropped in exactly one place.

It takes `SELECT … FOR UPDATE` first: without the lock, two grants arriving
together both read the old expiry and one is silently lost.

The trial is disqualified by `trialStartedAt`, which outlives the trial itself —
so a household cannot get a second one after expiry.

## Money is settled in the WHERE clause, not in an `if`

Both the redeem-code slot claim and the payment settlement put their conditions
in the UPDATE's `WHERE`, so Postgres re-evaluates them for the second
transaction after the first commits. Two people redeeming the last slot
together: one gets the row, the other gets zero rows affected.

`withAdvisoryLock` is explicitly **advisory, not exactly-once** — right for a
cron, wrong for money.

A PayOS webhook delivered twice is stopped by two independent barriers: the
unique `provider_txn_id`, and `status = 'pending'` in the settlement's WHERE.

## The expiry sweep (Phase 5)

`BillingExpiryCron`, **09:00 Asia/Ho_Chi_Minh** — not 23:45 like the valuation
job, because a notice has to land when people are awake.

One run, two independent halves:

1. Premium subscriptions past `currentPeriodEnd` → `status: 'expired'`, and each
   household's entitlement cache dropped.
2. `pending` orders past `expiresAt` → `expired`.

Design notes:

- **Lifetime is never touched.** `currentPeriodEnd IS NULL` falls outside
  `WHERE current_period_end < now()` by SQL's three-valued logic — no special
  case anyone can forget to write.
- **Both halves are idempotent**, which is what makes an advisory lock the right
  guard. A second run finds nothing left to flip.
- **The halves are independent.** A failure in one is logged and the other still
  runs — an unpaid checkout must still be closed when the subscription sweep
  cannot run.
- **A failed cache drop is not retried.** The row is already flipped, and
  `resolveEntitlement` re-checks the period on every read, so the cost is a
  stale cache entry until its TTL, never Premium the household did not pay for.
- Chunked with `LIMIT` + `FOR UPDATE SKIP LOCKED`; leftovers resume next run.

Kill switch: `BILLING_EXPIRY_CRON_ENABLED=false`. Batch size:
`BILLING_EXPIRY_BATCH_LIMIT` (default 500). Every instance runs its own
scheduler — see the "Scheduled jobs" rules in `CLAUDE.md`.

The household finds out through [[attention-items]]'s `plan_expiring_soon`,
derived from `daysRemaining`. **There is deliberately no email and no push
channel**: neither exists in this repo, `AttentionService` already derives items
this way, so an expiring plan costs nothing to add. Email waits until there is
an independent reason to build it.

## `BILLING_LIFETIME_ENABLED` stops sales, never revokes

Turning it off removes lifetime from `GET /billing/plans` and refuses new orders
for it. Households that already bought it keep it forever.

Worth watching: market-data API cost runs indefinitely against a single payment,
so capping lifetime sales by flipping this once a target is met is the lever.

## Pricing is a hypothesis until ~100 households

Every number in `PLAN_LIMITS` is a guess — cheap to change, since they live in
one file. Do not A/B prices before roughly 100 real households. The questions
worth answering first (and the answer that should worry you):

| Question | Worrying answer |
|---|---|
| Does anyone hit a limit? | <20% of Free households in 30 days ⇒ Free is too generous |
| Do they hit it too early? | Before day 3 ⇒ blocked before they trusted the app |
| Which paywall converts? | Any `reason` under 2% ⇒ that axis is not worth paying for |
| Trial → paid | <5% ⇒ Premium is not differentiated enough |
| Plan mix | Yearly under 40% ⇒ savings not legible, or not enough trust |
| Renewal | <60% ⇒ the app is not giving a reason to come back monthly |

None of these are answerable without analytics, which is not yet in the repo.

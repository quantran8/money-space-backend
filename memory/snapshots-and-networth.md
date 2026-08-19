# Snapshots, net-worth history & attention items

The periodic net-worth snapshot model that backs the dashboard trend and the "is the household OK?" question. Related: [[dashboard]], [[assets]], [[asset-valuation]].

## Snapshots

A `Snapshot` is a deliberately-taken frozen picture of a household. It persists:

**Balance-sheet totals:** `totalLiquid`, `totalSavings`, `totalLongTermAssets`,
`totalDebt`, `upcomingDueAmount`, `attentionCount`.

**Foresight context (v3.1, spec §10):** `forecastHorizonDays`,
`upcomingIncomeAmount`, `upcomingOutgoingAmount`, `lowestProjectedBalance`,
`flexibleMoney`.

There used to be a sixth, `protectedReserveAmount`. It went with the reserve
itself — including for snapshots already taken, which is why a handful of past
snapshots that read `tight` or `watch` because of a reserve now read `on_track`.
That was the accepted price of removing the concept rather than leaving a column
that freezes history about something the product no longer has.

The last two are **nullable and legitimately negative**. §10 explicitly forbids a
`>= 0` CHECK on them: a projected shortfall is the single most important thing a
snapshot can record, and a clamp would erase exactly the fact the product exists
to surface. NULL means "this snapshot predates the foresight columns" — carried
through as NULL rather than coerced to 0, because "we didn't record this" and "it
was zero" are different facts and only one of them is honest.

`financialState` (`on_track | watch | tight | incomplete`) and `sourceMode`
(`manual | calculated | mixed`) are **DERIVED at read time**, not stored — so
changing the derivation rule cannot leave old rows asserting something the
current code disagrees with.

`createdById` is nullable (`ON DELETE SET NULL`) — a snapshot outlives the
member who created it.

### A snapshot's financial state ≠ the live one

Live state comes from a full forecast run
(`forecast/domain/financial-state.ts`). A snapshot has no forecast to re-run, by
design: re-running today's engine over yesterday's row would produce a number
that changes every time you look at it — the opposite of what a snapshot is for.

So `snapshots/domain/snapshot-financial-state.ts` derives the same four codes
from the six frozen columns. It is a separate, smaller function on purpose:
pretending we have inputs we don't would be worse than admitting the reduced set.
Both share `FINANCIAL_STATE_THRESHOLDS`, so history and today can never disagree
about what "tight" means.

The old `deriveSnapshotStatus` (`good | attention | tight | insufficient_data`)
was **removed**. It judged a snapshot on net worth and whether liquid cash
covered what was due — a balance-sheet reading from before the product had a
forecast. The two rules disagree on the same household: positive net worth with a
shortfall on the 15th reads `good` under the old rule and `tight` under the new
one.

## SnapshotAssetValue

Denormalizes **each asset's value/type/liquidity/visibility at snapshot time**
(unique per `[snapshotId, assetId]`), plus `holder_member_id` — who was
responsible for it at the time (§17). This is what the dashboard's `assetTrend`
reads.

`financial_nature` and `privacy_owner_member_id` were dropped with the model they
belonged to (migration `20260815120100`, which writes its own `audit_logs` row
because reducing frozen history is exactly what §17 exists to prevent — accepted
only because every affected row was `household`/NULL).

Lines are read back from the LINE, never re-read through the asset: the asset may
have been reclassified since, and a past snapshot must keep meaning what it meant.

## SnapshotGoalValue

Freezes **each goal's resolved progress** at snapshot time (unique per
`[snapshotId, financialGoalId]`), alongside its name and target.

**Why frozen rather than recomputed.** A goal's progress is derived from its
allocations against live asset values, and allocations carry no history — so
recomputing "what did this goal hold in June?" from `SnapshotAssetValue` would
make an asset added today retroactively raise every past month. The history
would tell a story that never happened.

This is what makes the month-to-month question answerable: "we meant to set
aside 10tr, we managed 8tr because we spent 2tr" is the difference between two
month-end rows. Written by `getGoalLines` inside the same transaction as the
asset lines; read by `GET /financial-goals/:goalId/monthly-progress` and
`GET /financial-goals/:goalId/progress-change`.

**Two figures per row, not one.** `progress_amount` is the whole goal, market
value included. `contribution_progress_amount` is only the `contribution`-role
share — the wallets money flows through. The pace is measured on the second: a
wallet has no market price, so gold repricing can no longer answer "did we keep
our 10tr?" (it used to, wrongly in both directions). Both come from the same
allocations and the same asset values in one pass, so they cannot disagree about
one day.

Rows written before that column existed hold 0. A total > 0 with a contribution
of 0 means **not recorded**, not "nothing went in" — `findGoalProgressPoints`
reports it as `null` so the panel shows "—" rather than accusing a household of
missing months it may well have kept. Deliberately not backfilled, for the same
reason the figure is frozen at all.

`findGoalProgressChangeBasis` reads the latest row BEFORE today together with
that snapshot's `SnapshotAssetValue` lines — the basis for saying which asset
moved and by how much. See [[goals]].

## Snapshots are append-only, created deliberately (v3.1)

Snapshots are created by **`POST /snapshots`**. They are frozen pictures: once
written, nothing rewrites them.

**The auto-snapshot hooks were REMOVED in the v3.1 alignment.** `SnapshotsService`
used to expose `onAssetChanged` / `onAssetRemoved` / `onHouseholdChanged`, which
fired after every asset/debt/money-event write, upserted "today's snapshot" and
recomputed its totals from the current child rows.

Why they had to go:

- They **contradicted what a snapshot is**. Spec §26: *"snapshot đã tạo thì không
  đổi ngầm"*. A snapshot that keeps changing all day is not a frozen picture.
  `total_debt` in particular was re-read live on every recompute, so an unrelated
  debt edit could rewrite yesterday's *and* today's picture.
- They **failed silently**. Each hook was `try/catch`ed and swallowed its error,
  so a break showed up as snapshots quietly going stale — the worst failure mode.
- They **couldn't carry the v3.1 foresight columns**. Filling
  `lowest_projected_balance` / `flexible_money` needs a full forecast run (three
  extra queries plus occurrence expansion) — unacceptable on a latency-tuned
  write path that was budgeted to ~5 round-trips.

Removed with them: `ensureTodaySnapshot`, `upsertAssetLine`, `removeAssetLine`,
`recomputeSnapshotTotals`, and the partial unique index
`snapshots (household_id, snapshot_date) WHERE deleted_at IS NULL` — a household
may now snapshot as often as it likes, so a per-day constraint would reject
legitimate writes rather than protect anything. Double-tap protection lives in
the service instead (reject a second snapshot within 60s).

Existing rows are kept; provenance is already distinguishable via the audit
action (`snapshot.auto_created` vs `snapshot.created`).

**What did NOT regress:** the dashboard never read snapshots for the live
picture — it computes net worth on the fly (`DashboardService` +
`getOutstandingDebtTotal`). The only consumers of per-day rows were the
`assetTrend` chart and `GET /assets/snapshots`, so the trend simply gets coarser
until a scheduled snapshot job (driven by `households.update_frequency`) lands.
That is honest: a "trend" built from silently-mutating rows was never trustworthy.

### The write itself: 3 statements, 1 transaction

Everything expensive — valuing assets, running the forecast, totalling debt,
counting attention — happens **outside** the transaction. The transaction is
`insert snapshots` → `snapshotAssetValue.createMany(lines)` → `audit`.

An interactive transaction holds one connection open on the direct
(session-mode) client. Doing the reads inside it is how the old auto-snapshot
path used to die with *"Transaction not found"* on a slow household.

Totals are summed from the **same lines that get frozen**, so the header figure
and the per-asset breakdown cannot disagree — the exact failure mode of the
retired hooks, which recomputed totals from a separate live query.

Rate limit: one snapshot per 60s per household (`ConflictException`). Not a
business rule — a double-tap guard, since each snapshot writes a row per asset.

**Reads materialized `currentValue`**: the snapshot repository values assets via
its OWN reader (`getClassifiedAssetLines` + the pure `computeCurrentValue` util),
NOT `AssetsService` — so no dependency cycle forms.

`getClassifiedAssetLines` replaced `getActiveAssetLines`, which hardcoded
`visibilityLevel: 'detail'` on every line — so a line no longer claims a sharing
level the asset did not have.

## Immutability invariant

**A created snapshot never changes.** There are no update/delete endpoints on
snapshot rows or lines, and nothing mutates them after creation. Editing an old
valuation cannot rewrite a past snapshot.

This is also why `snapshot_asset_values` freezes `holder_member_id` and
`visibility_level` alongside the value — otherwise reassigning who holds an asset
would silently change what every past snapshot said. The freeze concept survives
the privacy removal; it simply freezes less. See [[sharing-levels]].

## AttentionItem

An alert/notification, kept calm and non-judgmental (see [[domain-overview]] tone rule):
- **level**: `normal | important | urgent`.
- **status state machine**: open → seen → resolved / dismissed. This IS the
  lifecycle — there is **no `deletedAt`** (dismissed = gone; a second delete flag
  would conflict). Queries exclude `dismissed` (or filter to `open`) instead of a
  soft-delete filter.
- **polymorphic link**: `relatedObjectType` ∈ asset / cashflow_event / financial_goal / snapshot / money_event / debt, plus `relatedObjectId`.
- **Attention is centralized here.** The old denormalized `is_attention_needed` /
  `is_large_event` flags on `money_events` and `is_attention_needed` on
  `upcoming_payments` were dropped — they were unread or pure-derived mirrors, and
  three sources of truth disagree. `cashflow_events.attention_level` stays (it
  carries the "important" flag that the status enum can't express).

**v3.1 rewrote how attention works.** Most signals are now DERIVED from the
forecast at read time and never stored; dismissals of derived signals are stored
as tombstones. See [[attention-items]] — that file is the source of truth, and
this section covers only the table.

## AuditLog

Append-only per-household action log (actor, action string, entityType/id, JSON metadata). Written on significant flows (e.g. `household.created`, `snapshot.created`). **`actorId` is nullable** (`ON DELETE SET NULL`): system/worker flows (auto-snapshot, price recalc) have no request user → NULL actor = system. The `writeAuditLog` raw-SQL writers no longer require `households.created_by IS NOT NULL`, so audit is written even when the owner is absent.

## Where it lives in code

- **backend**: `src/modules/snapshots/` (`POST`/`GET`, `domain/snapshot-financial-state.ts`),
  `src/modules/attention/`; schema entities `Snapshot`, `SnapshotAssetValue`,
  `AttentionItem`, `AuditLog`.
- **frontend-web**: consumed by `src/features/dashboard/` (asset trend, attention list).
- **mobile-app**: to be ported.

## Enums

`FinancialState = on_track | watch | tight | incomplete` (replaces the removed
`SnapshotStatus`), `SnapshotSourceMode = manual | calculated | mixed`,
`AttentionItemStatus = open | seen | resolved | dismissed`,
`AttentionLevel = normal | important | urgent`.

# Snapshots, net-worth history & attention items

The periodic net-worth snapshot model that backs the dashboard trend and the "is the household OK?" question. Related: [[dashboard]], [[assets]], [[asset-valuation]].

## Snapshots

A `Snapshot` is a periodic (weekly/monthly) net-worth snapshot of a household. It persists totals:
- `totalLiquid`, `totalSavings`, `totalLongTermAssets`, `totalDebt`, `upcomingDueAmount`, `attentionCount`.
- `status` (`good | attention | tight | insufficient_data`) and `sourceMode`
  (`manual | calculated | mixed`) are **DERIVED at read time** — from the totals +
  attentionCount, and from the child valuation methods respectively. They are
  **not stored columns** (dropped in migration `..._drop_dead_columns`): storing
  them would go stale if the derivation rule changed, and nothing wrote them.
- `createdById` is nullable (`ON DELETE SET NULL`) — a snapshot outlives the
  member who created it.

## SnapshotAssetValue

Denormalizes **each asset's value/type/liquidity/visibility at snapshot time** (unique per `[snapshotId, assetId]`). This is what the dashboard's `assetTrend` reads.

## Auto-snapshot (system-written, per-day, granular)

Snapshots are written **automatically by the system** whenever net worth changes
— there is NO manual create endpoint (POST removed; only GET list/detail remain).
`SnapshotsService` exposes three hooks, called AFTER the triggering write's
transaction commits:
- `onAssetChanged(householdId, assetId)` — asset create/update/sale: upsert that
  asset's snapshot line (or remove it if it's no longer active, e.g. fully sold).
- `onAssetRemoved(householdId, assetId)` — asset delete: drop its line.
- `onHouseholdChanged(householdId)` — debt / non-asset money-event: totals only.

**Per-day upsert**: each hook calls `ensureTodaySnapshot(householdId, today)` —
"today" in the household timezone (default `Asia/Ho_Chi_Minh`; a `timezone`
column can come later). One live snapshot per household per day, enforced by the
partial unique index `snapshots (household_id, snapshot_date) WHERE deleted_at IS
NULL` (migration `..._snapshot_one_per_day`). First change of the day CREATES the
parent + **seeds a FULL child set** for every active asset; later changes are
**granular** (upsert/remove just the affected asset's line).

**Totals = SUM of children, always.** `recomputeSnapshotTotals` sets the parent
`total_liquid/savings/long_term` from `SELECT liquidity, SUM(value) … GROUP BY
liquidity` over the CURRENT child rows (+ household-level debt/upcoming/attention),
so the parent can never diverge from its children regardless of granular edits.

**Reads materialized `currentValue`**: the snapshot repository values assets via
its OWN reader (`getActiveAssetLines` + the pure `computeCurrentValue` util), NOT
`AssetsService` — so `SnapshotsModule` imports only `CommonModule` and the
asset/money-event/debt modules import IT one-way (no dependency cycle). Safe
because every write-flow already refreshed `assets.current_value` via
`upsertCurrentValuation` in the just-committed transaction.

**Round-trip budget (latency-sensitive)**: the hot path (a same-day, non-seed
write) is tuned to ~5 sequential DB round-trips, which matters when the DB is
far (e.g. Supabase Tokyo ≈ 540ms/round-trip from a distant dev machine):
- The hooks do NOT wrap their steps in `runInTransaction` — every step is an
  idempotent upsert/recompute, self-healing on the next write, so a tx would
  only add an open+commit round-trip on the session pooler.
- `ensureTodaySnapshot` has a non-transactional fast-path SELECT; it opens a tx
  (to seed parent+children atomically) ONLY on the first write of the day.
- `toLine` skips `loadPricing` (2 queries) for `manual`/`formula_calculated`
  assets — only `market_priced` needs market prices / fx rates — and runs
  pricing (when needed) concurrently with the valuation-lineage lookup.
- `recomputeSnapshotTotals` is ONE `$executeRaw` UPDATE with correlated
  subqueries (child SUM-per-liquidity + debt/upcoming/attention), not groupBy +
  3 aggregates + update.

**Safety rails**: hooks run OUTSIDE the primary transaction and are `try/catch`ed
— an auto-snapshot failure logs and is swallowed, never breaking (already
committed) the asset/debt/event write. `isInTransaction()` guard: when a service
calls another's write inside its own tx (e.g. `createDebt` → `createMoneyEvent`),
the inner hook skips and the outermost caller fires the snapshot once (avoids
double-fire + reading uncommitted state). Money-event hooks refresh each linked
wallet's line (wallets change value via `applyWalletEffects`); accrual fires one
hook per deposit/wallet after its per-period transactions. Audit action
`snapshot.auto_created`, actor NULL (system). No debounce v1 — per-day upsert is
idempotent; repeated same-day writes just rewrite the same values.

**Live vs. historical**: the dashboard header net worth is computed on the fly
(`DashboardService`, using `getOutstandingDebtTotal` — the old hardcoded
`totalDebt = 18_000_000` is gone), NOT read from the latest snapshot. The
`assetTrend` reads the frozen `snapshots` rows.

## Immutability invariant

**Snapshots before today are immutable.** Only TODAY's snapshot is mutated
(granular upsert / recompute) until the day rolls over; days `< today` are never
touched (`ensureTodaySnapshot` keys strictly on `snapshot_date = today`). Editing
an old valuation therefore can't rewrite past snapshots. Enforced by omission:
no update/delete endpoints on snapshot rows/lines; `snapshot_asset_values` are
hard-deleted only within today's snapshot during granular removal.

## AttentionItem

An alert/notification, kept calm and non-judgmental (see [[domain-overview]] tone rule):
- **level**: `normal | important | urgent`.
- **status state machine**: open → seen → resolved / dismissed. This IS the
  lifecycle — there is **no `deletedAt`** (dismissed = gone; a second delete flag
  would conflict). Queries exclude `dismissed` (or filter to `open`) instead of a
  soft-delete filter.
- **polymorphic link**: `relatedObjectType` ∈ asset / upcoming_payment / financial_goal / snapshot / money_event / debt, plus `relatedObjectId`.
- **Attention is centralized here.** The old denormalized `is_attention_needed` /
  `is_large_event` flags on `money_events` and `is_attention_needed` on
  `upcoming_payments` were dropped — they were unread or pure-derived mirrors, and
  three sources of truth disagree. `upcoming_payments.attention_level` stays (it
  carries the "important" flag that `PaymentStatus` can't express).

## AuditLog

Append-only per-household action log (actor, action string, entityType/id, JSON metadata). Written on significant flows (e.g. `household.created`, `snapshot.created`). **`actorId` is nullable** (`ON DELETE SET NULL`): system/worker flows (auto-snapshot, price recalc) have no request user → NULL actor = system. The `writeAuditLog` raw-SQL writers no longer require `households.created_by IS NOT NULL`, so audit is written even when the owner is absent.

## Where it lives in code

- **backend**: schema entities `Snapshot`, `SnapshotAssetValue`, `AttentionItem`, `AuditLog`; read via `src/modules/dashboard/`.
- **frontend-web**: consumed by `src/features/dashboard/` (asset trend, attention list).
- **mobile-app**: to be ported.

## Enums

`SnapshotStatus = good | attention | tight | insufficient_data`, `SnapshotSourceMode = manual | calculated | mixed`, `AttentionItemStatus = open | seen | resolved | dismissed`, `AttentionLevel = normal | important | urgent`.

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

## Creation flow (spec §26)

`SnapshotsService.createSnapshot(householdId, dto)` (`src/modules/snapshots/`):
1. Reads OUTSIDE the transaction (keep it short): active assets with computed
   `currentValue` via `AssetsService.getActiveAssetRecords` (SAME valuation
   engine as the live dashboard → totals can't diverge); `getOutstandingDebtTotal`
   (Σ active debts), `getUpcomingDueTotal` (Σ unpaid payments), open attention count.
2. Builds a frozen line per asset, each referencing the asset's current
   `AssetValuation` via `valuationId` (lineage back-pointer; null if none — the
   line still freezes the value).
3. Totals via `computeLiquidityTotals`.
4. In ONE transaction: insert the `snapshots` row (`created_by` resolved from
   household owner, no request user) → bulk `createMany` of `snapshot_asset_values`
   → `snapshot.created` audit log.

**Live vs. historical**: the dashboard header net worth is computed on the fly
(`DashboardService`, using `getOutstandingDebtTotal` — the old hardcoded
`totalDebt = 18_000_000` is gone), NOT read from the latest snapshot, so it
reflects today's prices. The `assetTrend` reads the frozen `snapshots` rows.

**Worker seam**: `POST /api/households/:id/snapshots` is the trigger (manual now).
No cron in-app — an external worker calls it on a schedule; `createSnapshot` is
free of HTTP/schedule concerns so a future batch endpoint can reuse it.

## Immutability invariant

**Snapshots are immutable.** Editing an old valuation must NOT silently rewrite past snapshots — history is frozen at snapshot time. See [[domain-overview]]. Enforced by omission: the snapshots module exposes NO update/delete of snapshot rows or line items.

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

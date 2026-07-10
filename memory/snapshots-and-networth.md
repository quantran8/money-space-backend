# Snapshots, net-worth history & attention items

The periodic net-worth snapshot model that backs the dashboard trend and the "is the household OK?" question. Related: [[dashboard]], [[assets]], [[asset-valuation]].

## Snapshots

A `Snapshot` is a periodic (weekly/monthly) net-worth snapshot of a household. It persists totals:
- `totalLiquid`, `totalSavings`, `totalLongTermAssets`, `totalDebt`, `upcomingDueAmount`, `attentionCount`.
- `status` ∈ `good | attention | tight | insufficient_data`.
- `sourceMode` ∈ `manual | calculated | mixed`.

## SnapshotAssetValue

Denormalizes **each asset's value/type/liquidity/visibility at snapshot time** (unique per `[snapshotId, assetId]`). This is what the dashboard's `assetTrend` reads.

## Immutability invariant

**Snapshots are immutable.** Editing an old valuation must NOT silently rewrite past snapshots — history is frozen at snapshot time. See [[domain-overview]].

## AttentionItem

An alert/notification, kept calm and non-judgmental (see [[domain-overview]] tone rule):
- **level**: `normal | important | urgent`.
- **status state machine**: open → seen → resolved / dismissed.
- **polymorphic link**: `relatedObjectType` ∈ asset / upcoming_payment / financial_goal / snapshot / money_event / debt, plus `relatedObjectId`.

## AuditLog

Append-only per-household action log (actor, action string, entityType/id, JSON metadata). Written on significant flows (e.g. `household.created`).

## Where it lives in code

- **backend**: schema entities `Snapshot`, `SnapshotAssetValue`, `AttentionItem`, `AuditLog`; read via `src/modules/dashboard/`.
- **frontend-web**: consumed by `src/features/dashboard/` (asset trend, attention list).
- **mobile-app**: to be ported.

## Enums

`SnapshotStatus = good | attention | tight | insufficient_data`, `SnapshotSourceMode = manual | calculated | mixed`, `AttentionItemStatus = open | seen | resolved | dismissed`, `AttentionLevel = normal | important | urgent`.

# Dashboard (overview / snapshot)

Single-glance household financial status — answers *"Tài chính gia đình có ổn không?"*. Read-only aggregation. Related: [[snapshots-and-networth]], [[assets]], [[debts]], [[goals]], [[money-events]].

## Overview

Fans out to every other feature's data (snapshot + assets summary + market prices + FX + upcoming payments + goals + money events + snapshots) and composes one view.

## Composed cards

- **Snapshot card**: liquid total + split (cash vs bank_account), savings (`not_immediately_usable`), debt, **netWorth = totalAssets − totalDebt**, attention count, plus the goal split below.
- **Goal split**: `earmarkedForGoals` (Σ each goal's resolved progress) and
  `unassigned` (`totalAssets − earmarkedForGoals`, floored
  at 0). This is **display only** — `netWorth` is NOT reduced by it, and
  flexible money keeps its own formula. Setting money aside does not make a
  household poorer, and subtracting earmarks from the headline figure is the
  shape that got `protected_reserves` removed (a goal with a monthly
  contribution is already pulled down by the forecast — subtracting it here too
  counts it twice). No cap is needed: every goal is a set of shares of assets, each bounded by its
  asset's live value and checked against over-allocation at write time, so the
  sum is structurally at most `totalAssets`. See [[goals]].
- **Asset trend**: sparkline from historical snapshots (`assetTrend` reads `SnapshotAssetValue`, see [[snapshots-and-networth]]).
- Debts, long-term goal, members, recent events, and attention ("cần chú ý") sections.

## Status bucket rule (`statusVariantFor`)

Frontend uses a simplified attention-count mapping:
- `attentionCount > 2` → `tense`
- `attentionCount > 0` → `attention`
- else → `stable`

(The backend spec defines a fuller status: good / attention / tight / insufficient_data based on liquidity vs. upcoming due, overdue items, and staleness. Frontend currently uses the simplified version — reconcile when wiring real snapshots.)

## Net-worth invariant

Borrowing raises an asset **and** a debt equally, so net worth does **not** inflate. See [[debts]], [[domain-overview]].

## Attention levels (Vietnamese labels)

`normal` / `important` (Quan trọng) / `urgent` (Khẩn cấp) / "Cần trao đổi". See [[snapshots-and-networth]] for AttentionItem.

## Known demo shortcut

Backend dashboard `totalDebt` is currently hard-coded to `18,000,000` — not a real rollup. Replace with an actual debt sum when leaving demo state.

## Where it lives in code

- **frontend-web**: `src/features/dashboard/{model/dashboard.ts, hooks/use-dashboard-overview.ts, hooks/use-dashboard-page.ts, api/dashboard.repository.ts, ui/...}`.
- **backend**: `src/modules/dashboard/` (`dashboard.service.ts`, `entities/{attention-item,snapshot-point}.entity.ts`, `repositories/prisma-dashboard.repository.ts`).
- **mobile-app**: to be ported.

## Enums

`StatusVariant = stable | attention | tense` (frontend); backend snapshot status `good | attention | tight | insufficient_data` is **derived at read time** (`deriveSnapshotStatus`), not a stored enum/column — see [[snapshots-and-networth]].

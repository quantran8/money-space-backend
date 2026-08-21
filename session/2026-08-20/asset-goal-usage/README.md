# Asset detail: which goals claim this asset, and what is free

- **Date**: 2026-08-20
- **Session folder**: `session/2026-08-20/asset-goal-usage/`
- **Status**: done

## What the task is

The asset detail page showed a balance with no hint that most of it might
already be promised to a goal. The allocation relationship was only ever visible
from the goal's side, so the question people actually bring to an asset page —
"how much of this is mine to use?" — could only be answered by opening every goal
in turn and adding up.

## Changes made

**Backend** (`money-space-backend`)

- `goals/goals.service.ts` — `assetGoalUsage(householdId, assetId)`: the goals
  claiming one asset, plus `claimedAmount` / `freeAmount`.
- `goals/asset-goal-usage.controller.ts` (new) — `GET /households/:id/assets/:assetId/goal-usage`.
- `goals/goals.module.ts` — registers the new controller.

**Frontend**

- `shared/api/query-keys.ts` — `assetGoalUsage`, nested under the **goals**
  prefix so allocation writes invalidate it.
- `features/goals/api/goals.repository.ts` — `getAssetGoalUsage` + types.
- `features/goals/hooks/use-asset-goal-usage.ts` (new).
- `features/assets/ui/components/asset-goal-usage-section.tsx` (new) — a
  claimed/free composition bar plus a table of goals, each row navigating to the
  goal. Reuses `MoneyCompositionBar`.
- `features/assets/ui/asset-detail-page.tsx` — renders it above the info card.
- `i18n/resources.ts` — `assets.detail.goals.*` in both `vi` and `en`.

## Key decisions

- **The route lives in the goals module** even though its path is under assets.
  `GoalsService` already imports `AssetsService`; the reverse edge would be a
  cycle. Mounting the controller in Goals keeps the dependency one-way while
  still giving the asset page the URL it expects.
- **Every role is listed, not just wallets.** `walletUsage` (used by the goal
  create form) filters to `contribution` because only wallets have a monthly
  pace. Here that filter would be wrong: gold behind a goal is promised just as
  much as cash, and this page is where someone asks whether they can use it.
- **`freeAmount` reuses `sumAllocatedAgainstAsset`** — the same subtraction the
  write path enforces — so the page cannot promise a household room that a new
  claim would then be refused.
- **The empty state says so explicitly** rather than hiding the panel: "no goal
  draws on this yet" is an answer worth giving.
- **Query key sits under `goals`, not `assets`.** The answer changes when an
  allocation is written; under the assets prefix it would go stale until the
  asset itself happened to change.

## Mobile app parity notes

- Port the section: composition bar (claimed vs free) + goal rows linking to the
  goal detail screen.
- Read `GET /households/:id/assets/:assetId/goal-usage`; all arithmetic is
  server-side.
- Keep the query cached under the goals key so allocation writes refresh it.

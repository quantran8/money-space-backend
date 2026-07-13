# Financial goals

Shared savings goals with progress. Related: [[money-events]] (goal_contribution), [[assets]] (linkedAsset).

## Overview

CRUD over `FinancialGoal` (name, category, targetAmount, deadline, priority, status). The goal itself does **not** store a source wallet. Every response is a card including a computed **progress %**.

## Rules

- **The money source is chosen PER CONTRIBUTION, not on the goal.** A goal has no
  source wallet — the old `linked_asset_id` column was dropped (migration
  `..._drop_goal_linked_asset`). Instead, each `goal_contribution` money event
  carries its own `fromAssetId`: the wallet that specific contribution comes out
  of. So creating/editing a goal never asks for or validates a wallet.
- **Contributing debits the chosen wallet.** A `goal_contribution` money event
  MUST carry `fromAssetId` = a cash/bank wallet — the backend rejects a
  contribution with no / non-wallet source (400,
  `MoneyEventsService.assertGoalContributionSource`). It debits that wallet
  (money leaves the spendable pocket) while `direction` stays **neutral**, so it
  is a move between the household's own pockets — NOT counted as spending in the
  thu/chi summary (same treatment as a transfer). The frontend goals page's
  quick-add row has a required "nguồn tiền" wallet picker per goal (defaults to
  the first wallet). See [[money-events]].

- **`currentAmount` is DERIVED, not stored.** It is the live `Σ amount` of the
  goal's `goal_contribution` money events (`deletedAt IS NULL`), computed on read
  in `PrismaGoalsRepository` (`groupBy` for lists, `aggregate` for one goal). The
  DB column was dropped (migration `..._drop_dead_columns`) — it was a cache
  nothing maintained (no increment on contribution, no reverse on delete). Create/
  update never write it; a new goal starts at 0. See [[money-events]].
- **Progress** (`computeProgress` / `computeGoalProgress`): `round(min(100, current / target × 100))`; `0` if `target ≤ 0`.
- **Invariant** (`buildGoalSchema.refine`): `current ≤ target`.
- **Suggested pace** (`suggestedPace`): remaining amount spread over ~4 months, floored at 1,000,000 VND when short.
- **Priority ordering** (`priorityRank`): high = 0 < medium = 1 < low = 2 (used to sort/allocate).
- Deadline defaults to "No deadline" when absent.
- **Delete**: soft-delete + unlink from money events.

## Where it lives in code

- **frontend-web**: `src/features/goals/{model/goals.ts, model/goals.types.ts, model/goals-form.ts, api/goals.repository.ts, hooks/...}`.
- **backend**: `src/modules/goals/` (`goals.service.ts`, `entities/financial-goal.entity.ts`, `repositories/prisma-goals.repository.ts`).
- **mobile-app**: to be ported.

## Enums

- `GoalPriority = high | medium | low`
- `GoalStatus = active | paused | completed | cancelled`
- `GoalCategory = emergency_fund | home | home_repair | children | travel | debt_repayment | investment | education | other`

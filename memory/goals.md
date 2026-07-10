# Financial goals

Shared savings goals with progress. Related: [[money-events]] (goal_contribution), [[assets]] (linkedAsset).

## Overview

CRUD over `FinancialGoal` (name, category, targetAmount, currentAmount, deadline, priority, status, optional `linkedAssetId`). Every response is a card including a computed **progress %**.

## Rules

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

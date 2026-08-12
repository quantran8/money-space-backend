# Financial goals

Shared savings goals with progress and a v3.1 projection. Related: [[money-events]] (goal_contribution).

## Overview

CRUD over `FinancialGoal` (name, category, targetAmount, currentAmount, plannedMonthlyContribution, targetDate, priority, status). The goal itself does **not** store a source wallet. Every response is a card including a computed **progress %**.

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

- **`currentAmount` is STORED, and is the source of truth for progress** (spec
  v3.1 §20). It is a real `financial_goals.current_amount` column — NOT derived
  from `goal_contribution` events.

  **Why it changed back:** deriving it showed `0` for every household that
  arrives with savings predating the app ("we already have 200M toward the
  house"), and there is no honest event to invent for that money.

  **Why the earlier stored column failed, and what is different now:** it was a
  cache nothing maintained — no increment on contribution, no reverse on delete
  — so it drifted. The column is now maintained by
  `MoneyEventsService.applyGoalContributionEffects`, called inside the **same
  transaction** as the money event: create adds the amount, delete subtracts it,
  and an edit reverses the old value then applies the new one (so an amount
  change or a re-link to another goal nets out exactly). The repository floors it
  at 0 in the same statement. **If you add another path that writes a
  `goal_contribution`, it must call that method or the column starts lying
  again.** Pinned by `money-events.goal-mirror.spec.ts`.

  `currentAmount` is accepted on **create** (onboarding records an existing
  balance) and rejected on **update** — `UpdateFinancialGoalDto` omits it and
  the service re-reads the stored value.
- **`plannedMonthlyContribution`** drives the projection. `null` or `<= 0` means
  *no projected completion date* — show progress only and invite the user to
  declare a contribution. Never divide by it unguarded.
- **`deadline` was renamed to `targetDate`** (spec §20). The API currently emits
  **both** (`targetDate` plus a transitional `deadline` alias) so the pre-v3.1
  client keeps working; the alias goes away once the frontend goals slice reads
  `targetDate`.
- **Progress** (`computeProgress` / `computeGoalProgress`): `round(min(100, current / target × 100))`; `0` if `target ≤ 0`.
- **Invariant** (`buildGoalSchema.refine`): `current ≤ target`.
- **Suggested pace** (`suggestedPace`): remaining amount spread over ~4 months, floored at 1,000,000 VND when short.
- **Priority ordering** (`priorityRank`): high = 0 < medium = 1 < low = 2 (used to sort/allocate).
- Target date defaults to the `NO_TARGET_DATE` sentinel (`"No deadline"`) when absent.
- **Delete**: soft-delete + unlink from money events.

## Where it lives in code

- **frontend-web**: `src/features/goals/{model/goals.ts, model/goals.types.ts, model/goals-form.ts, api/goals.repository.ts, hooks/...}`.
- **backend**: `src/modules/goals/` (`goals.service.ts`, `entities/financial-goal.entity.ts`, `repositories/prisma-goals.repository.ts`).
- **mobile-app**: to be ported.

## Enums

- `GoalPriority = high | medium | low`
- `GoalStatus = active | paused | completed | cancelled`
- `GoalCategory = emergency_fund | wedding | home | home_repair | car | children | travel | debt_repayment | career_break | investment | education | other`


## Projection (§26C)

`projectGoal` (pure, `goals/domain/goal-projection.ts`) answers "when will we get
there at the current pace":

- `remaining = max(0, target − current)`
- `estimatedMonthsToGoal = ceil(remaining / plannedMonthlyContribution)` — **ceil,
  because a partial month is still a month**
- **fully-funded is checked FIRST**, so a completed goal reports
  `already_complete` even when no contribution was ever declared
- **never divide by a null or `<= 0` contribution.** No contribution →
  `projectedCompletionDate: null`, `reason: 'no_contribution'`; the UI shows
  progress only and invites the user to declare a pace. Inventing one would be
  the product making up a number about the household's money.
- `requiredMonthlyContributionForTargetDate` is the Goals-screen figure (04 §8);
  a target date in the past returns `remaining` with `reason:
  'target_date_passed'`.
- **No investment-return assumptions**, ever. The product does not speculate.

`NO_TARGET_DATE` (`'No deadline'`) is a wire sentinel, not a date — it must be
mapped to `null` before reaching `projectGoal`, or every undated goal looks due
on the string "No deadline".

### Where it is exposed

| Route | Notes |
|---|---|
| `GET /financial-goals?include=projection` | opt-in; the goal picker in a form doesn't need it |
| `GET /financial-goals/:id` | always attached |
| `GET /financial-goals/:id/projection` | on `ForecastController` |

The list computes projections **in `GoalsService`**, from this module's own
`domain/`, rather than calling `ForecastService` — `ForecastModule` imports
`GoalsModule`, so the reverse edge would be a cycle.

`projectGoalAfterSpend` powers the what-if goal impact: money taken **from** the
goal re-derives the date exactly; money that merely displaces future
contributions uses `spend / monthlyContribution` (05 §5.1). See
[[forecast-and-flexible-money]].

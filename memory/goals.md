# Financial goals

Shared savings goals. Related: [[assets]] (allocations),
[[snapshots-and-networth]] (the frozen history), [[dashboard]].



## A percent claim is not re-derived when a wallet is spent from

`allocationValue` takes a `percentBasis`: what "50% of this wallet" is a
percentage OF, which is **not** the wallet's value after a spend.

A percent allocation describes a standing arrangement, not a figure that
re-computes itself every time a bill is scheduled. Re-reading it against the
lowered value shaved every goal proportionally **even when the spend fitted
inside unassigned money**: paying 5tr out of a 52tr wallet with 26tr unassigned
reported "mục tiêu giảm 2,5tr" when the honest answer was zero. An outflow takes
unassigned money first — that is the whole rule — and a percent claim that shrinks
regardless breaks it.

The claim is still **capped at what the wallet holds afterwards**, so a genuinely
unaffordable spend does still reduce the goals. Only the basis is pinned.

Callers that lower a wallet (`walletValuesAfterOutflows`, `resolveSpendImpact`)
pass the ORIGINAL values as the basis. It threads through
`resolveGoalCommittedAmount`, `…ByGoal`, `…PartsByGoal`,
`resolveWalletShareByGoal` and `sumAllocatedAgainstAsset` — **all of them**,
because free room is `value − set aside`, and measuring the two halves against
different bases makes them stop adding up.

**This has been violated once, and the failure is worth remembering.**
`resolveGoalCommittedAmount` computed its set-aside half by calling
`allocationValue(allocation, assetValues)` — dropping the basis — while its pace
half passed it through `resolveWalletShareByGoal`. With a `percent: 90` claim on
a 28,8tr wallet and a 2tr bill, the set-aside half read 90% of the LOWERED 26,8tr
(24,12tr) and the pace half read 90% of the unspent 28,8tr (25,92tr). The 1,8tr
gap surfaced on the dashboard as flexible money that did not exist — every đồng
of that wallet was either goal money or the bill.

Guarded by "keeps the percent basis in the set-aside half" in
`goal-progress.spec.ts`. The lesson generalises: whenever a function takes
`percentBasis`, EVERY `allocationValue` call inside it must forward it. Dropping
it is silent — the arithmetic still returns a plausible number.

## Two different "free" figures — do not mix them up

`assetGoalUsage` returns two pairs, and using the wrong one states a
contradiction on screen:

| pair | question it answers | includes monthly pace? |
|------|--------------------|------------------------|
| `claimedAmount` / `freeAmount` | "how much may a NEW allocation still take?" | **no** |
| `committedAmount` / `unassignedAmount` | "how much of this wallet has no job yet?" | **yes** |

A monthly pace does not stop a new claim from taking the same money, so
`freeAmount` rightly ignores it — that is the write path's rule
(`assertWithinAssetValue`). But "chưa dành cho mục tiêu nào" is the second
question, and it must agree with the dashboard's "đã có nhiệm vụ".

**The bug this fixed:** a 52tr wallet with 20tr set aside behind `car`, and both
`car` and `nhà` promising 20tr/month, showed **"32tr chưa dành cho mục tiêu nào"**
on the asset page while Home counted the whole 52tr as committed. Both paces were
drawing on that 32tr; none of it was unassigned. The same wrong figure then fed
the spend warning, which claimed 32tr was free directly above a list showing
every đồng of it coming out of the goals.

Per goal, the same split exists: `currentValue` is the set-aside half alone,
`countedValue` is all in. The table's "đang tính" column must use `countedValue`
— `currentValue` printed "0đ" next to a goal the dashboard counts 16tr behind.

Both all-in figures come from `resolveGoalCommittedAmountByGoal`, the same
resolver Home uses, so the screens cannot disagree about one wallet.

## Overview

A goal is **a set of shares of real assets** — nothing more. It stores no
figure of its own; progress is summed from its allocations at live asset values.

CRUD over `FinancialGoal` (name, category, targetAmount, targetDate,
plannedMonthlyContribution, priority, status). Every response carries the
**resolved progress amount** and a computed **progress %**.

## The one rule

**"Shared money" is not a separate kind of money.** Setting aside 100tr from the
household's shared money is a fixed 100tr share of the `cash`/`bank_account`
asset holding it — declared exactly like a share of gold or stocks.

There used to be two backing modes (`earmark` / `asset_backed`). `earmark` was a
stored figure floating free of any asset, so nobody could answer "where is that
100tr actually sitting?", and because it was a bare declaration it could exceed
what the household owned — which is why the dashboard needed a
`Math.min(totalAssets, …)` cap. Both are gone. Every good property of the model
came from being anchored to an asset; `earmark` was the exemption that carried
the original problems back in.

```
progress = Σ  kind='fixed'   → min(allocated_amount, asset.current_value)
              kind='percent' → asset.current_value × percent / 100
```

## Rules

- **A goal cannot be created without at least one allocation** (400 otherwise).
  A goal with no assets has no progress and no way to gain any, so it would sit
  at 0% forever. `POST /financial-goals` takes the goal AND its shares in one
  transaction; the create form asks for them in the same step.
- **At least one of those shares must be a `cash`/`bank_account` asset** (400
  otherwise), and the goal's **last wallet share cannot be deleted**. Money is
  only ever put INTO a goal through a wallet; backed by gold alone a goal's
  figure moves on the market, which is not the household saving, and "did we keep
  our pace?" has no source to read. The rule spans `goal_asset_allocations` and
  `assets`, so no CHECK can see it — `GoalsService` enforces it on create and on
  allocation delete. Goals created before the rule are left alone: it governs
  what may be written, not what history says happened.
- **Assets are shared by the part, not claimed whole.** 100tr of stocks can send
  50tr to the car goal and leave the rest free or feeding another goal.
- **`fixed` is capped at the asset's live value on read.** Declaring 50tr against
  a position now worth 30tr reports 30tr — that is the truth, and it is why
  spending needs no goal-side write at all.
- **Over-allocation is checked at write time, across ALL goals**, against the
  DECLARED figure (not the capped one — comparing capped values let a 500tr claim
  against a 100tr asset slip through). Claims made in one create payload are
  counted against each other too.
- **Money leaves a goal by being spent from its asset.** There is no contribution
  event, no withdraw event, and no goal link on a money event. Progress falls on
  the next read.
- **Net worth is never reduced by a goal.** The dashboard shows a display split
  (`earmarkedForGoals` / `unassigned`) and needs no cap: the sum is structurally
  at most `totalAssets`. See [[dashboard]].

## Monthly pace — "did we keep it up?"

The headline figure answers *how much is behind this now*. The question a
household actually asks month to month is different:

> we meant to set aside 10tr a month; January was exactly 10tr, in February we
> spent 2tr of it so only 8tr went in.

That is a DIFFERENCE between two points in time, which is why each goal's
progress is **frozen into every snapshot** (`snapshot_goal_values`). A month's
figure is the goal's progress at the last snapshot of that month minus the same
for the previous month — so it already accounts for money added, money spent out
of a backing asset, and the asset repricing. Nothing separate is recorded and
nothing can disagree with it.

- `buildGoalMonthlyProgress` (pure, `domain/goal-monthly-progress.ts`) turns the
  frozen points + the declared pace into `{ month, delta, planned, gap, inProgress }`.
- **The first month is measured from the goal's creation baseline**
  (`financial_goals.baseline_contribution_amount`), frozen at creation from the
  `contribution` shares' resolved value. The create form asks two separate
  questions — how much is *already* set aside, and how much goes in *each month*
  — and the baseline is the answer to the first. Without it the first month had
  no left-hand side and reported `—`, which reads as "we cannot say" about a
  figure the household had just stated. With it, a goal created this month shows
  `0` against its pace and climbs as money actually moves in.
  - It is **never** the wallet's unallocated remainder. A wallet holding 22tr
    with 20tr behind the goal did not contribute the leftover 2tr — that money
    was never behind this goal, and crediting it would report a contribution for
    a top-up to an unrelated balance.
  - **Frozen once, never rewritten.** `updateFinancialGoal` does not touch it:
    after the first contribution lands, opening balance and new money are mixed
    together and the original answer is no longer recoverable.
  - The baseline applies to the **first month only**. Later months compare
    against the month before them, so it can never overwrite real history. The
    adjacency guard below is likewise skipped for the first month — its
    left-hand side is the baseline, not an older close, so no skipped months can
    hide in the difference.
- **A goal with no baseline still has `delta: null` for its first month** — a
  household arriving with 200M already saved did not save it that month. This is
  the pre-baseline behaviour, kept for goals created before the column existed
  whose first month has already closed.
- **Months with no snapshot are skipped**, never filled with 0: no snapshot means
  nobody looked, which is not the same as "nothing was saved".
- A negative month is reported as-is. Falling short is information, not an error
  — the UI uses `--attention`, never `--alert`, and never a verdict.
- **The month still running gets a row too** (`inProgress: true`), measured to
  live progress instead of a month-end close. Without it a household mid-month
  sees its 10tr target and nothing else, and has to wait for the month to end to
  learn where it stands — the feedback the "contribute" button used to give
  before goals stopped holding money of their own. Live progress simply joins
  the frozen points as one more point dated today; being the latest, it wins its
  own month.
  - The row states what is **left to go**, not what is missing: an unfinished
    month is not a shortfall, so it stays neutral in colour where a closed short
    month uses `--attention`.
  - **Its delta is withheld unless the immediately preceding calendar month has
    a close.** A gap in snapshots would otherwise bundle several months of
    saving into "this month" — a flattering figure. Closed months still compare
    against the previous month present in the data, where spanning a gap is the
    honest reading.
  - It still appears with no declared pace: knowing the month is up 6tr is
    useful even with nothing to compare against.
  - **When it has no real previous close, its figure is an ESTIMATE of capacity,
    not money observed moving** (`resolveMonthlyContributionHeadroom`). A month
    that has not ended cannot be reported as kept or missed, and for a goal just
    created the observed difference is 0 — true but useless. So the panel shows
    what the wallets can still put in:

        per wallet: max(0, min(walletValue - setAside, monthlyContribution))

    …where `walletValue` is **net of this month's outflows that have not happened
    yet** — see "The running month is measured after scheduled outflows" below.

    **The row carries `isEstimate: true` in exactly this case**, so the UI can
    label it honestly. Without the flag the panel called the figure "Đã góp"
    (already contributed), which claims money moved when none may have — the
    number is capacity, not a record. It is the only place the flag is ever set:
    an observed difference between two closes is `isEstimate: false`, running
    month or not.

    Wallet 22tr with 20tr set aside and a 20tr pace → 2tr. Wallet 30tr → 10tr.
    **Capped by the wallet's own declared pace**: 100tr in the account does not
    mean 80tr goes to the car — the household said 20tr a month, so the estimate
    stops there and the month reads as met, never as a surplus.
    - **Capped per wallet, then summed**, never wallet-total against goal-total.
      A goal fed by a full account and an empty one would otherwise report the
      full one's surplus as covering the empty one's pace.
    - **`setAside` spans EVERY goal, not just this one**
      (`sumAllocatedAgainstAsset` over the household's allocations). Goals
      sharing a wallet compete for one balance: 22tr with 20tr already behind
      goal 1 leaves 2tr, and goal 2 must see 2tr too. Measuring each against the
      full balance reported 2tr and 20tr — 22tr of estimates against 2tr of free
      money, the same "one đồng promised twice" the allocation rule forbids.
    - **Goals sharing a wallet are served in ONE pass, by priority**
      (`resolveWalletShareByGoal`). Estimating per goal had two goals on a 2tr
      wallet each report 2tr — 4tr of capacity against 2tr of money. The wallet
      is now divided once, for every goal that draws on it:
      1. Free room = wallet value − every goal's claim on it.
      2. `high` is served before `medium` before `low`. A high goal takes its
         full declared pace before a lower one gets anything.
      3. Within one priority — the tie `priority` cannot break — the shares are
         consulted ONLY if the room cannot cover every pace in the group. When it
         can, each goal simply takes its pace and `share_percent` goes unused.
      4. Each goal stays capped at its own pace, and what a cap leaves behind
         flows on to the next priority group.

      The totals therefore can never exceed what the wallet holds free.
    - **The split within a tie is the household's, asked for at creation**
      (`goal_asset_allocations.share_percent`). Settling a tie by creation date
      would have the product ranking their plans for them. The create form asks
      the moment a wallet already backs another goal at the SAME priority —
      before the money runs short, because by then the split has been guessed at
      and the guess is what they would be correcting.
      - Written only for a contested wallet. NULL means "never asked", not 100.
      - `GoalsService.assertShareWithinWallet` refuses shares of one wallet that
        together pass 100% WITHIN a priority. Goals at different priorities never
        divide anything, so their shares are unrelated and are not added up.
      - The total is not required to reach 100: the first goal on a wallet
        declares its share before the second one exists.
    - **Fallback when a tie has no shares** — goals predating the column, or a
      pair the household made same-priority after creating them: split in
      proportion to the declared paces, and set `needsShareDecision` so the panel
      asks rather than presenting the fallback as a decision.
    - **Floored at 0.** A wallet drawn below its share has nothing left to give;
      that is 0, not a negative contribution.
    - **Closed months never use it.** Once a month ends, the difference between
      two closes is the truth, and an estimate must not rewrite it. The running
      month also prefers the observed figure whenever a real previous close
      exists.
- Exposed at `GET /financial-goals/:goalId/monthly-progress`; rendered by
  `GoalMonthlyProgressSection` on the goal detail page.

### Scheduled outflows are shown BESIDE the figures, in ONE section

A goal's pace, set-aside amounts and totals are measured against the wallets **as
they stand**, with scheduled outflows still in them. Money that has not moved has
not been spent — a bill can still be cancelled or postponed, and reporting it as
already gone would state as fact something that has not happened.

What those outflows will cost is answered by **one endpoint and one section**,
never by a projected field hung off each metric:

    GET /financial-goals/:goalId/scheduled-outflow-impact
    -> null | { throughDate, events[], outflowAmount,
                currentAmount, projectedAmount,
                plannedMonthlyContribution, currentPace, projectedPace }

`null` when nothing is scheduled against this goal's wallets, so the section does
not render at all.

**Why one section.** A scheduled outflow moves several figures at once — the
total held, the month's pace, each affected wallet. The first attempt attached a
projected number to each of them and read badly: the same fact restated three
times, explained none, with the cause (a named bill, on a date) having nowhere to
live. The household was left assembling the story from fragments. One section
carries the whole thing, names the events, and leaves every other figure alone.

**Only the parts that actually move are rendered.** A percent claim keeps the
untouched wallet as its basis, so with tcb at 28,8tr, a `percent: 90` claim and a
2tr bill: the pace line appears (2,88tr → 0,88tr) and the total line does not
(205,02tr both). A bill has to be large enough to reach past the free room before
the total moves.

**The long-range projection is deliberately NOT re-forecast.** The finish date and
the pace line on the chart keep using the DECLARED pace. A squeezed month is this
month only — the wallet refills — so projecting a one-month dip across years would
report a pessimistic finish date the household never chose. The section says the
month is short; it does not restate the goal.

Bounded to the **end of the current month**: a bill due in three months takes
nothing away from this month.

**Contrast with the forecast**, which DOES lower the figure it reports
(`walletValuesAfterOutflows`). That is right there: flexible money answers "what
can I spend", and money earmarked for a bill cannot be spent twice. A goal's pace
answers "what have we put in" — a different question about a different moment.
The two must not be "fixed" into agreement.

### Where the pace comes from: the wallets declare it

**The monthly pace is declared per wallet, never on the goal.** Each
`contribution` share of a `cash`/`bank_account` asset carries its own
`monthly_contribution`, and `financial_goals.planned_monthly_contribution` is
the **sum of them** — "10tr a month" is stored as "6tr out of the salary account
and 4tr in cash".

A figure typed on the goal named no account the money would come out of: it could
be declared for a goal backed entirely by gold, and the pace panel then compared
it against wallet movement it had no relationship to. Declaring it on the share
means the plan and the accounts that have to carry it out are the same rows.

- **The goal column stays, as a maintained mirror.** `GoalsService` rewrites it
  from `resolvePlannedMonthlyContribution` in the same transaction as every
  allocation write (`syncGoalPace`). It is stored rather than summed on read
  because every goal surface shows the pace — the list, the dashboard, the
  forecast — and none of them otherwise reads `goal_asset_allocations` at all.
- **`PATCH /financial-goals/:id` never sets it.** The field is ignored whatever
  the body carries; the pace is edited on the shares.
- **Only a `contribution` share of a wallet may carry an amount** — enforced by
  `GoalsService` for the asset type and by the
  `goal_asset_allocations_monthly_contribution_role` CHECK for the role. A figure
  on gold is REJECTED, not dropped: a household that typed it has misunderstood
  something, and storing nothing would let them keep believing it.
- **NULL, not 0, when no wallet declares one.** 0 is a promise to save nothing —
  every month would be reported as kept, and the projection would divide by it.
  NULL is "no pace planned": progress only, no projected date, no monthly verdict.
- Clearing a share's amount sends `monthlyContribution: null`; omitting the field
  on a PATCH leaves the stored one alone.
- **In the UI a `contribution` share asks for TWO numbers, and they answer
  different questions**: *đang có sẵn cho mục tiêu* — what the wallet already
  holds for it, which is progress — and *góp mỗi tháng từ ví này*, which is pace.
  Stacked unlabelled they read as the same question twice, so both carry a label
  here and nowhere else.
  - The asset picker offers only `cash`/`bank_account` while the role is
    `contribution`, and the role control appears only for a wallet — nothing is
    ever paid INTO gold on a schedule, and a control with one possible answer
    only invites a mistake.
  - **The share is always a fixed amount**, never a percent: fixed/percent is a
    `holding`-only choice, because a wallet has no market price and "a share of
    whatever it is worth" says nothing a plain amount does not.
  - **It may be left empty.** "We start saving 6tr a month from today" is how a
    goal usually begins, and demanding a starting figure would make the household
    invent one. Refused only when the row declares NEITHER an amount nor a
    monthly figure — then it claims nothing at all. `allocatedAmount: 0` has
    always been valid server-side.
- The API is deliberately NOT narrowed to match any of this — the role, the kind
  and the share stay the household's, and anything made through the API still
  resolves correctly. The one place the two could disagree is the edit dialog: a
  percent contribution share made through the API opens as a fixed amount, seeded
  with what it is worth today.

### Contribution vs. holding: what the pace measures

Every allocation carries a `role`:

- **`contribution`** — the wallet money flows through. Counts towards progress
  AND towards the monthly pace.
- **`holding`** — value already accumulated (gold, stocks, crypto). Counts
  towards progress only.

The pace used to be measured on the TOTAL, which answered "did we keep our
10tr-a-month?" with the gold price — wrongly in both directions: gold up 10tr in
a month nobody contributed to read "đủ nhịp", and gold down 10tr in a month they
saved the full 10tr read "thiếu". A wallet has no market price, so a pace built
from wallets alone needs no separating of price from principal; there is nothing
to separate.

**The household chooses the role; the asset type only seeds the default** (wallet
→ `contribution`). Deriving it on read would count a spending wallet as savings
and would stop a household from saying "only this second wallet feeds the goal".

`snapshot_goal_values.contribution_progress_amount` freezes the contribution part
next to the total, from the same allocations and the same asset values, so the
pace and the progress can never disagree about one day. Rows written before that
column existed hold 0; a total > 0 with contribution 0 means **not recorded**, and
`findGoalProgressPoints` reports it as `null` so the panel shows "—" rather than
accusing a household of missing months it may well have kept. It is deliberately
NOT backfilled — recomputing from `snapshot_asset_values` plus today's
allocations would make adding a wallet now rewrite what June's pace "was", which
is the whole reason the figure is frozen.

**A goal with no contribution source reports no pace at all** (`planned: null`).
A goal backed only by gold was never meant to be fed monthly, and showing
"0 / 10tr · thiếu 10tr" every month is a verdict on a plan nobody made.

**Converting cash into a holding inside one goal does not count as a
withdrawal.** Buying 10tr of gold from a wallet that feeds the goal drops that
wallet, so the pace would read −10tr as if the money were spent — but the goal's
total did not move: the household changed the form it holds.
`findGoalConversionPurchases` finds `asset_purchase` events whose source AND
destination both belong to the goal, and `buildConversionCredit` adds them back.
A purchase paid into an asset OUTSIDE the goal really does take money out of it
and keeps showing as such. This is only possible because `asset_purchase` now
carries `from_asset_id` (see [[assets]]); before that, a wallet falling and gold
rising were two unrelated facts and pairing them would have been a guess.

### Why the progress bar explains itself

A goal backed by gold reprices on its own: a household that saw 50% yesterday and
48% today changed nothing, and with no explanation the figure looks arbitrary — a
number nobody can explain is a number nobody trusts.

The tempting fix, freezing the asset at its value when assigned, is worse than
the problem: a goal claiming 250tr of gold that would fetch 240tr today does not
reassure the household, it misleads them, and it is the same stored figure
floating free of its asset that `earmark` was. So the figure keeps following the
assets and `GET /financial-goals/:goalId/progress-change` supplies what was
missing: the delta since the last frozen point, and which assets moved.

- Compares against the most recent snapshot BEFORE today, naming its date unless
  it was yesterday — otherwise "hôm qua" would quietly describe a fortnight.
- Compares each allocation's WORTH, not the asset's raw value: a goal claiming
  half a position only felt half of that position's move.
- Assets that JOINED or LEFT the goal are named too; without that, the largest
  moves of all would go unexplained.
- Returns null when nothing moved — a line reading "no change" is noise.
- A fall uses `--attention`, never `--alert`: the market moving is information,
  never the household's fault.

**Why frozen rather than recomputed:** allocations carry no history. Recomputing
from `snapshot_asset_values` would make adding an asset today retroactively raise
every past month, so the history would tell a story that never happened.

## API

| Route | Notes |
|---|---|
| `GET /financial-goals?include=projection` | resolves progress for every goal in one pass |
| `GET /financial-goals/:goalId` | projection + `allocations[]` |
| `POST /financial-goals` | requires `allocations[]` (>= 1), one of them a wallet; pace comes from their `monthlyContribution` |
| `PATCH /financial-goals/:goalId` | never allocations, never the pace — both have their own routes |
| `DELETE /financial-goals/:goalId` | soft-delete + unlink events + drop allocations |
| `GET /financial-goals/:goalId/monthly-progress` | the pace panel |
| `GET/POST /financial-goals/:goalId/allocations` | a wallet share may declare `monthlyContribution` |
| `PATCH/DELETE /financial-goals/:goalId/allocations/:allocationId` | DELETE refuses the last wallet; both rewrite the goal's pace |

## Where it lives in code

- **backend**: `src/modules/goals/` — `goals.service.ts`,
  `domain/goal-progress.ts`, `domain/goal-monthly-progress.ts`,
  `domain/goal-projection.ts`, `domain/wallet-values-after-pending.ts` (all
  pure), `repositories/`.
  Snapshot freezing lives in `src/modules/snapshots/`.
- **frontend-web**: `src/features/goals/{model,api,hooks,ui}` —
  `goal-allocations-field.tsx` (create form), `goal-allocations-section.tsx`,
  `goal-allocation-dialog.tsx`, `goal-monthly-progress-section.tsx`.
- **mobile-app**: to be ported.

## Enums

- `GoalAllocationRole = contribution | holding`
- `GoalAllocationKind = fixed | percent`
- `GoalPriority = high | medium | low`
- `GoalStatus = active | paused | completed | cancelled`
- `GoalCategory = emergency_fund | wedding | home | home_repair | car | children | travel | debt_repayment | career_break | investment | education | other`

## Projection (§26C)

`GET /financial-goals?include=projection` (and the per-goal
`/projection` route) attach a `GoalProjection`. The web client always requests
it, since every v3.1 goal surface shows one.

**When `plannedMonthlyContribution` is undeclared** the projection comes back
with `reason: 'no_contribution'` and there is no honest projected date. The UI
must then show **progress only** — inventing a date from past behaviour would
be a guess presented as a fact. `hasProjectedDate()` in
`model/goal-projection.types.ts` is the single check for this.
- **Delete**: soft-delete + unlink from money events.

## Where it lives in code

- **frontend-web**: `src/features/goals/{model/goals.ts, model/goals.types.ts, model/goals-form.ts, api/goals.repository.ts, hooks/...}`.
- **backend**: `src/modules/goals/` (`goals.service.ts`, `entities/financial-goal.entity.ts`, `repositories/prisma-goals.repository.ts`).
- **mobile-app**: to be ported.

## Enums

- `GoalPriority = high | medium | low`
- `GoalStatus = active | paused | completed | cancelled`
- `GoalCategory = emergency_fund | home | home_repair | children | travel | debt_repayment | investment | education | other`

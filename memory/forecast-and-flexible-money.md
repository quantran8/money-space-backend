# Forecast, flexible money & what-if

The calculation core of v3.1. Related: [[cashflow-events]],
[[goals]], [[sharing-levels]], [[snapshots-and-networth]].

## Why day-by-day

A household can end the month positive and still be in trouble on the 15th.
The spec's own example (05 §2):

```
Today 20M → 15 Aug rent −25M → −5M → 20 Aug salary +30M → 25M
```

End-of-month is +25M and looks fine. The household is actually 5M short on the
15th. **Lowest projected balance** is the number that surfaces that, and it is
why the forecast walks every calendar day instead of summing a period.

That example is pinned as the golden test in `domain/forecast.spec.ts`. If it
ever fails, the product is broken regardless of what else passes.

## Where it lives

Everything pure lives in `src/modules/forecast/domain/` (plus
`src/modules/goals/domain/goal-projection.ts`). Pure means: no Nest, no Prisma,
no clock. `asOfDate` is always an argument, so every run is deterministic and
unit-testable. `ForecastService` is a thin Nest wrapper that loads a bundle and
delegates.

**Nothing here writes.** There is no `forecasts` table and no
`what_if_scenarios` table, deliberately (§2.12, §35). Virtual occurrences and
synthetic events are objects that never leave memory.

## The forecast (§26A)

1. Window `[asOfDate, asOfDate + horizonDays]`, **inclusive both ends** — so
   `horizon_days=30` yields 31 day rows.
2. Starting balance = Σ assets with `liquidity = usable_now`. Savings and
   long-term holdings are net worth, not cash flow; counting them would make a
   household look liquid when its money is locked up.

   **Zero `usable_now` assets is not a balance of 0đ.** The sum is 0 either way,
   but the two mean different things: a wallet holding nothing is a balance the
   household has, while no wallet at all means there is no balance to run down.
   With no source, every projected figure derived from it (`lowestProjectedBalance`,
   the timeline's running-balance column) is arithmetic on money nobody holds —
   a 1tr outflow rendered as "−1,0 triệu", which reads as an overdraft that does
   not exist. The UI shows **"—"** for both in that case, gated on
   `usableNowAssetCount === 0`; `no_liquid_sources` (a financial-state reason)
   is what explains why. A genuine deficit — an outflow larger than a real
   wallet — still shows its negative figure: that is the screen's whole purpose.
   Sums of real events (`Tiền vào` / `Tiền ra`) are unaffected, since they
   depend on no balance existing.

   The count rides on **both** payloads — `ForecastResult` and
   `FlexibleMoneyResult` — because the dashboard's hero reads the flexible one
   and would otherwise have no way to tell 0đ from "no wallet".
   `currentSharedLiquidMoney` cannot answer it: it is the same 0 either way.

   One predicate, `canProjectBalance(usableNowAssetCount)` in the web's
   `forecast-presentation`, gates every surface: the dashboard hero
   (`financial-picture-section`), the dashboard's projected low and its
   running-balance column (`upcoming-section` / `buildTimelineRows`), and the
   Upcoming screen's summary and timeline. It is deliberately shared — the rule
   was first fixed on Upcoming alone, and the dashboard went on showing
   "−1,0 triệu" in red because it computes the same figures from its own copy of
   the logic. `undefined` reads as "there is a source", so an older server can
   never blank a column.

   **Not yet applied to what-if**, which compares a before/after pair through
   `WhatIfSideResult` — a payload that does not carry the count. With no wallet
   both sides are projections of money nobody holds.

   The household can overrule the type default per asset —
   `assets.counts_as_flexible` (see [[assets]]) — but that override is
   **materialized into the `liquidity` column**, so this step is unchanged and
   still reads one materialized bucket. The forecast must never grow a second,
   private rule about which assets are spendable: that is precisely what once
   put it out of step with the dashboard.

   **Liquidity is the only filter.** Sharing level is never consulted: the
   engine no longer even receives it. See [[sharing-levels]] for why, and
   `shared-figures.spec.ts` for the test that keeps this figure in agreement
   with dashboard net worth, the asset summary and snapshot totals — they used
   to disagree.
3. Drop `completed` / `cancelled`. `postponed` is **shown but not counted** —
   its date is no longer trustworthy.
4. Expand recurrence virtually (see [[cashflow-events]]).
5. **Sort outgoing before incoming on the same day.** We don't know the intraday
   order, and assuming the salary lands before the rent leaves would hide a real
   shortfall.
6. Count incoming only when `certainty = confirmed` (unless explicitly
   overridden). `estimated` is emitted with `countedInBalance: false` so the UI
   can show it without the balance depending on it.
7. Walk every day, emitting empty ones too so the chart draws a continuous line.
8. `lowestProjectedBalance` keeps the **earliest** date on ties — that's the day
   to act on.
9. Obligation coverage is a **second pass counting only `required` outgoing**.
   Discretionary plans must not make the household look unable to pay its bills.

## Flexible money (§26B, 05 §3)

Two forms, both may be negative:

- **Conservative (Home)**:
  `liquid − required outflows before the next confirmed inflow`.
  The window is **inclusive of the inflow date** — same conservative reasoning
  as the same-day ordering.
- **Horizon**: `lowestProjectedBalance` itself. This is what what-if compares,
  because it answers "can I spend this without the balance ever going negative".

Both used to subtract the protected reserve, and the horizon form was exported
under its own name (`flexibleMoneyHorizon`) for exactly that reason. The reserve
was retired, so the subtraction is gone and the second name with it — an API
that returns one figure under two names invites a client to treat them as two
different things.

**Two rules that must not be "tidied":**

1. **Never clamp to zero.** Negative flexible money means the household has
   already committed more than it holds — the exact situation the product exists
   to surface. `Math.max(0, …)` would hide it.
2. **Never label it a spending allowance.** Not "ngân sách được phép tiêu", not
   "số tiền bạn nên tiêu" (design §12.3). It is what remains unassigned.

## Goal money is committed money (`goalCommitments`)

"Already has a job" is TWO things, and only one of them is a bill:

- **Near-term obligations** — what must be paid before more money arrives. This
  is what `lowestProjectedBalance` subtracts.
- **Goal money** — what the household set aside behind a goal, plus what this
  month's pace can still draw from what is left.

Only the first used to count, so money explicitly promised to a goal was offered
back as free: a household with 20tr of a 22tr wallet behind the car was told it
had 22tr flexible. Promising money to a goal and then seeing it presented as
spendable is the overstatement this screen exists to prevent.

`GoalsService.resolveGoalCommitments` → `resolveGoalCommittedAmount` (pure, in
`goals/domain/goal-progress.ts`), passed into `computeFlexibleMoney` by
`ForecastService`. `flexibleMoney`, `financialState` and `forecastBundle` all
pass it, so no endpoint reports the figure without it.

- **The two halves cannot double-count.** Money already set aside is money a
  pace would otherwise claim a second time — a wallet holding 28.8tr with 20tr
  set aside can feed a 20tr pace by at most the 8.8tr still free. The second
  half is `resolveWalletShareByGoal`, which is free-room-only by construction
  (and already ordered by priority and split by the declared shares).
  Adding the raw figures on real data gave 140tr against 109.8tr of money.
- **Liquidity is the caller's filter.** The value map is built from
  `ForecastResult.liquidSources` — the very `usable_now` rows
  `startingLiquidBalance` was summed from — so the two can never disagree about
  what is liquid. Gold behind a goal contributes nothing, because it was never
  in the liquid total this is a share of.
- **Measured AFTER the horizon's outflows** (`walletValuesAfterOutflows`), not
  against today's balances. See the section below — this is what stops an
  outflow being charged twice.
- **`liquidSources` is carried on the forecast result** rather than reloaded.
  Loading the bundle again would have bypassed the forecast cache and issued a
  second query per request — the "one load" test guards this.
- The composition bar floors the flexible slice at 0 (it is a split of what
  exists), while the hero figure stays unclamped: negative means more is
  committed than is held, which is rule 1 above.

## An outflow outranks the goals sharing its wallet

**Money leaving the household is an obligation; money behind a goal is a promise
the household makes to itself, and a promise yields to a bill.** So when an
outflow settles from a wallet a goal is saving into, the goal is counted as
holding less — it does not push flexible money below zero.

The order in which a goal gives way is fixed:

1. **This month's contribution first** — the part of the pace that had fit in the
   wallet's free room.
2. **Then what was already set aside**, once the contribution is gone.

Worked example (the one the rule was written against) — TCB holds 22tr, 20tr set
aside behind `car`, pace 20tr/month, of which only 2tr fits this month:

| outflow | contribution | set aside | goal claim | flexible |
|---------|--------------|-----------|------------|----------|
| 0       | 2tr          | 20tr      | 22tr       | 0        |
| 2tr     | 0            | 20tr      | 20tr       | 0        |
| 5tr     | 0            | 17tr      | 17tr       | 0        |

**Lowering the wallet value IS the implementation** — there is no separate
draining routine, and that is deliberate. Both halves of
`resolveGoalCommittedAmount` already read the wallet's value: the pace is capped
by free room (so it goes first), and `allocationValue` caps a fixed claim at the
wallet's value (so what is set aside goes next). `walletValuesAfterOutflows`
(`forecast/domain/`) lowers the value; the ordering falls out.

Only outflows **counted in the balance** are subtracted, so this map and the
forecast's own balances always agree about what is leaving. Incoming events are
deliberately not added — money that has not arrived backs no goal yet.

### The bug this fixed

`goalCommitments` was measured against today's untouched balances while
`lowestProjectedBalance` had already walked the timeline and subtracted the same
outflows. `lowest − goalCommitments` therefore charged **every outflow twice**,
and the Home hero reported negative flexible money for a household that had
merely scheduled a bill against a wallet its goals were saving into — 22tr wallet
fully behind a goal, plus one 2tr bill, read "−2tr linh hoạt". The composition
bar hid the same error behind its `Math.max(…, 0)` floor.

Note this is **not** an exception to "never clamp to zero". The negative was
arithmetic double-counting, not a household that had over-committed; rule 1 is
about not hiding a real over-commitment, and a real one still shows.

### The settlement wallet is asked at completion, not at planning

`settlementAssetId` is **optional on both directions** at create/update time. It
is carried through `ForecastCashflowEvent` → `ForecastOccurrence` so the forecast
knows which wallet an outflow drains when one is named.

It was briefly required for outgoing events, to keep an outflow from draining no
goal. That was reverted: **a debt is not tied to one wallet.** The household
repays from whichever cash/bank wallet suits them that month, so a repayment
generated months ahead by `createRepaymentSchedule` genuinely cannot name its
wallet — requiring one made every scheduled debt fail to save.

The guarantee is enforced at the moment money actually moves instead:
`completeCashflowEvent` resolves `payload.assetId ?? event.settlementAssetId` and
**rejects a completion naming neither**, so a confirmation can still never settle
into a silent no-op.

### Showing the cost before it is paid

`GET /api/households/:householdId/assets/:assetId/spend-impact?amount=` — a read,
called while the cashflow form is still being filled in. Returns per-goal
`before`/`after`/`reduction` (biggest loser first) plus `exceedsWallet`.

`resolveSpendImpact` (`goals/domain/spend-impact.ts`) is a before/after of
`resolveGoalCommittedAmountByGoal` around one lowered wallet value — deliberately
not a second implementation of the ordering rule.

**Resolve every goal TOGETHER, never one at a time.** Calling the amount resolver
per goal with a single-element array measures each as if it were alone on the
wallet, so every goal sees the whole wallet as its own free room and the per-goal
figures sum to more than the wallet holds — two goals on a 20tr wallet reported
15tr and 13tr. The competition between goals for the same room IS the rule
(`resolveWalletShareByGoal`: priority order, then the declared shares), and it
only exists when they are resolved as a group. That is what
`resolveGoalCommittedAmountByGoal` exists for.

**The web form does not call this endpoint.** It computes the same answer locally
(`features/goals/model/spend-impact.ts`) so the figures appear as the household
types, with no round trip to race against a quick save. The two implementations
must change together; the frontend copy is verified against this one's worked
examples.

A goal quietly losing 3tr because a bill was scheduled against its wallet is the
silent erosion this endpoint exists to prevent.

**Report WHICH half gave way, never just the total.** `paceReduction` and
`setAsideReduction` (and their totals) are separate fields because they are
different events for the household:

- **this month's contribution** — a month of saving paused;
- **money already set aside** — the goal moving backwards.

They are not equally serious, and a single total cannot say which happened. Since
the pace is always squeezed out first, a spend that fits inside it must read as
pace-only rather than alarming about set-aside money that was never touched.
`resolveGoalCommittedPartsByGoal` keeps the halves apart;
`resolveGoalCommittedAmountByGoal` is it summed, for callers that only need the
figure.

### What-if obeys the same rule (and says more about it)

Three bugs and three gaps, all fixed together:

- **Both sides now carry goal money.** `computeFlexibleMoney` was called with no
  `goalCommitments` on either side, so what-if reported flexible money that
  ignored every goal — a larger figure than Home showed for the same household,
  from the screen whose entire job is being trusted about consequences.
- **The spend is spread across wallets, not charged to one.** What-if names no
  wallet (it is a question, not a payment), so `spreadAcrossWallets` decides, in
  this order:

  1. **Genuinely free money in EVERY wallet** — the part no goal claims, pooled
     across all wallets. Making a goal give way while another account still held
     unpromised cash would invent a sacrifice the household would not make.
  2. **Then goal money, by the household's own ranking** — `low` before `medium`
     before `high`, one wallet drained before the next.
  3. **Amount breaks ties inside a rank** — the wallet promising least goes
     first. **Priority outranks amount, and the order matters**: 1tr promised to
     a `high` goal is not more expendable than 50tr towards a `low` one just
     because it is a smaller number. The household ranked their goals; spending
     the important one first answers a question they did not ask.

  Ties break on wallet id last — the same question must always get the same
  answer. `PRIORITY_RANK` is exported from `goal-progress.ts` so every
  "which goal gives way first" decision reads the ranking the same way; a second
  copy is how `medium` ends up outranking `high` on one screen and not another.
- **`goalImpact` reports money AND time, per goal.** "Mục tiêu giảm 3tr" says
  what leaves; "chậm 2 tháng" says what it costs, and the second is what decides
  anything. `projectGoalDelayFromSpend` converts each half against the goal's own
  pace: set-aside money leaving lowers the balance, a skipped contribution moves
  the finish line by the fraction of a month given up. A goal with no declared
  pace reports `null` rather than a fabricated month count.
- **`newlyAtRisk` names the bills that stop being payable.**
  `obligationsCovered: false` is enough to colour a badge and useless for acting:
  nobody can move a bill without knowing which bill and when. Only items the
  spend actually breaks are listed — one already going unpaid is not this
  purchase's doing (`findNewlyAtRisk` diffs before against after).
- **`uncovered`** is the part no wallet could cover at all — the money is not
  there, which is a different fact from a later bill going unpaid.

`findAtRiskOccurrences` mirrors the forecast's own obligation pass exactly, so it
can never disagree with `obligationsCovered` about whether there is a problem.
`planned` outflows are never REPORTED (a discretionary choice is not an unmet
obligation) but do still SPEND — the what-if event is `planned` by construction,
and if it did not move the balance the feature could not answer anything.

## Financial state (05 §6)

`on_track | watch | tight | incomplete`, replacing the old
`good | attention | tight | insufficient_data`.

Precedence: `incomplete` → `tight` → `watch` → `on_track`. **All** matching
reasons are returned, not just the winning one, so the UI can explain itself.

`incomplete` means *absence of data*, never a judgement about money — no liquid
sources or nothing to forecast.

Thresholds live in the exported `FINANCIAL_STATE_THRESHOLDS` so changing one is
a deliberate edit with a failing test, not a magic number drifting.

## What-if (§26D, 05 §5)

Build a synthetic outgoing event in memory, re-run the forecast, diff. The
bundle is loaded **once** — running the engine twice must not mean querying
twice.

The synthetic event is `requirement: 'planned'` (a purchase is a choice, so it
moves the balance without breaking obligation coverage) and
`certainty: 'confirmed'` (if you're asking, you'd actually spend it).

Goal impact has two shapes: money taken **from** the goal re-derives the date
exactly; money that merely displaces future contributions uses
`spend / monthlyContribution` (05 §5.1).

**It is a READ.** `POST /what-if` deliberately carries **no**
`@RequireCapability('edit')` — a `view_summary` partner must be able to ask
"what happens if we spend this?". It is a POST only because it needs a body.

**It reports consequence, never a verdict.** `resultType`
(`comfortable | watch | tight | not_covered`) is a calm classification for
styling, not advice. The product never says whether to buy.

**Analytics carry only a bucket** — `{householdId, hasGoal, hasAssetSale,
amountBucket, resultType}`. Never the amount, never the balances: a couple's
figures stay theirs.

### Funding a spend by selling an asset

The forecast starts from `usable_now` money only, so a household with 500tr
liquid and 600tr of stock who asks about an 800tr car gets an answer built on
500tr. `liquidity.shortfall` names that gap, and an optional
`assetSale: {assetId, amount}` lets them ask the second question: "…and if we
sold 300tr of the stock to pay for it?"

**`shortfall` is the trigger, not `resultType` and not a negative low point.**
The synthetic spend is `requirement: 'planned'`, and the obligation pass counts
only `required` outgoing — so `obligationsCovered` can never flip from the spend
itself. And a negative low point is a *horizon* fact: a spend can be perfectly
fundable today and still bottom out on day 22 because of a later bill, where
"sell your stock" is the wrong suggestion. `shortfall` means precisely "the
money is not there yet", which is the only case this step answers.
`liquidity.shortfall` and `goalImpact.uncovered` carry the same figure and are
asserted equal in the spec so they cannot drift.

**The sale is a t0 rebalance of `input.assets`, NOT a synthetic incoming
event.** This is the decision most likely to be "simplified" later. A synthetic
inflow is wrong twice over:

- `startingLiquidBalance` never sees it, so `flexibleMoneyToday` would not move
  at all despite money landing today — and worse, the event would become
  `nextSufficientlyCertainInflow`, shrinking the flexible-money window and
  pushing the figure *up* for a reason unrelated to the sale.
- `walletValuesAfterOutflows` deliberately never credits incoming money, so the
  receiving wallet would not be credited in the goal math: the goals would pay
  for the spend *and* for the sale. Carving a hole in that rule for synthetic
  events puts the one function two callers depend on into two minds.

A rebalance is also correct on *every* day of the horizon rather than only from
a sale date onward, which is what a conversion actually means. Hence no
`saleDate` field: there is no timeline position for a date to occupy.

**Wallet-only maps for spending, wallet-plus-sold-asset maps for attribution.**
The sold asset must never reach `goalClaimsByWallet` → `spreadAcrossWallets`, or
an illiquid asset would pay for the purchase with no sale at all. It reaches
only the two maps handed to `spendImpactAcrossWallets`, where it makes a goal
backed by that asset show the loss. The receiving wallet's credit is already
inside `drain.values`; adding it to the attribution maps too would count the
proceeds twice.

Three engine runs over one bundle, and the third only when a sale was asked for
— a what-if without one behaves exactly as before. `before`/`after` keep their
meanings and `afterSale` is added, so the client can show what the sale bought.

**Everything the household READS comes from the after-sale run when there is
one.** `newlyAtRisk`, `resultType` and `obligationsCovered` were all resolved
against `afterForecast` — the spend WITHOUT the sale — while the client renders
the after-sale side as the answer. So a bill the proceeds had already covered
was still listed as broken, carrying a running balance that ignored every đồng
raised: a 200tr spend against ~26tr of wallets printed −174tr beside a 4tr bill
that the sale had in fact paid for. One `answerForecast = afterSaleForecast ??
afterForecast` now feeds all three, so the tone, the flag and the list cannot
describe a different world from the figures beside them.

**No fee.** A sale's only net-worth effect is `−fee`, and what-if reports no
net-worth figure; at exploration time nobody knows the brokerage fee anyway. A
field left at 0 would imply the simulation accounted for something it did not.
`netProceeds` stays a distinct field so adding a fee later does not change what
`amount` means. The client renders a `noFee` assumption line.

**Several holdings per sale, one destination.** `assetSale.lines` is a list of
`{assetId, amount}`, because one holding is often not enough: short 500tr
against 300tr of gold and 250tr of stocks, a single-asset step is a question
with no answer the household could act on. Every line is validated the same way
(sellable, non-`usable_now`, within its own value), and the same asset twice is
refused — two lines each passing their own bound would sell 200% of it.
`applyAssetSale` subtracts every line and credits the destination once with the
total.

**The receiving wallet is named by the caller** (`assetSale.toAssetId`),
validated `usable_now` and different from every asset being sold — the same two
rules a real `asset_sale` enforces.

**A household with no `usable_now` wallet names `UNASSIGNED_WALLET_ID`.** It
used to fail validation with nothing it could send instead. The proceeds then
join the run as a `usable_now` source of their own (`unassignedProceeds`) rather
than crediting an account — the truth of an imagined sale: usable money no goal
is standing in front of. It is refused whenever the household DOES hold a
wallet, or it would become a way to park money outside the reach of the goals
sitting in front of a real account — the very fact the caller names one for. The engine used to pick the least-promised
wallet; it cannot, because which account holds the cash decides which goals it
is sitting in front of, and that is the household's call. This is a narrow
exception to the no-wallet-picker rule, which is about the SPEND's routing and
still holds; see `frontend/memory/what-if.md`.

Sellability is `SELLABLE_ASSET_TYPES`, which lives on `asset.entity.ts` so the
pure engine can read it without importing a Nest provider —
`AssetsService.SELLABLE_ASSET_TYPES` re-exports the same set. A simulated sale
and a real one can never disagree about what is sellable.

## Assumptions are codes, never sentences

Every result carries `assumptions: {code, value?, relatedIds?}[]`. The client
owns all copy (the frontend has a hard i18n mandate), and spec §3 requires every
number to be openable via "how was this calculated". The backend never emits a
localized string — pinned by a test that rejects Vietnamese diacritics in
assumption values.

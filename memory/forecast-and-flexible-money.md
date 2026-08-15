# Forecast, flexible money & what-if

The calculation core of v3.1. Related: [[cashflow-events]], [[protected-reserves]],
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
  `liquid − reserve − required outflows before the next confirmed inflow`.
  The window is **inclusive of the inflow date** — same conservative reasoning
  as the same-day ordering.
- **Horizon**: `lowestProjectedBalance − reserve`. This is what what-if
  compares, because it answers "can I spend this without ever breaking the
  reserve".

**Two rules that must not be "tidied":**

1. **Never clamp to zero.** Negative flexible money means the household has
   already committed more than it holds — the exact situation the product exists
   to surface. `Math.max(0, …)` would hide it.
2. **Never label it a spending allowance.** Not "ngân sách được phép tiêu", not
   "số tiền bạn nên tiêu" (design §12.3). It is what remains unassigned.

## Financial state (05 §6)

`on_track | watch | tight | incomplete`, replacing the old
`good | attention | tight | insufficient_data`.

Precedence: `incomplete` → `tight` → `watch` → `on_track`. **All** matching
reasons are returned, not just the winning one, so the UI can explain itself.

`incomplete` means *absence of data*, never a judgement about money — no liquid
sources or nothing to forecast. A missing reserve is a reason, never enough on
its own.

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

**Analytics carry only a bucket** — `{householdId, hasGoal, amountBucket,
resultType}`. Never the amount, never the balances: a couple's figures stay
theirs.

## Assumptions are codes, never sentences

Every result carries `assumptions: {code, value?, relatedIds?}[]`. The client
owns all copy (the frontend has a hard i18n mandate), and spec §3 requires every
number to be openable via "how was this calculated". The backend never emits a
localized string — pinned by a test that rejects Vietnamese diacritics in
assumption values.

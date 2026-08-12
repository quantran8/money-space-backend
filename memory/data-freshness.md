# Data freshness

How old the household's picture is (spec 04 §12, §22). Related: [[assets]],
[[attention-items]], [[forecast-and-flexible-money]], [[settings-and-sharing]].

## Why it exists

v3.1 leads with a forecast, and a forecast is only as trustworthy as the balances
it starts from. If the bank balance was last touched six weeks ago, the "lowest
projected balance" is arithmetic on a guess.

So the product says how old the picture is — and says it **without implying the
household did anything wrong**. Stale data is a fact about the data, never a
judgement about the couple.

## The cadence is the household's own

`households.update_frequency` decides the window:

| Cadence | Stale after |
|---|---|
| `weekly` | 8 days |
| `monthly` | 31 days |
| `manual` | **never** |

The extra day is grace: a household that updates every Sunday must not flip to
stale for a few hours every Sunday morning. 31 covers the longest month.

**`manual` never goes stale.** They explicitly said "we'll update when we want
to"; grading them against a schedule they never agreed to is exactly the nagging
[[attention-items]] §29 forbids. The age is still *reported* — they can see it,
they're just not graded on it.

## States

`fresh | aging | stale | unknown`

`aging` starts at 75% of the window. It exists so the UI has a calm middle step —
a quiet "worth a look" before anything reads as a problem. Without it, a value
jumps straight from fine to stale.

**`unknown` is not `stale`.** A value that was never dated means we genuinely
don't know; reporting it as stale asserts something we cannot support, and would
make every freshly-imported asset look neglected.

## Confirm-unchanged

`POST /assets/confirm-unchanged` bumps `value_updated_at` **without touching
`current_value`**.

"I checked, it hasn't changed" is real information about freshness. Forcing the
user to re-type the same number to express it is busywork that also risks a typo.

It deliberately writes **no valuation history point**: nothing about the money
changed, so a history entry would put a fictional data point on the asset's
chart. With no `assetIds` it confirms every active asset — the one-tap case from
the freshness sheet, which is the whole reason this endpoint exists.

## `AS_OF` is dead

Every read path used to stamp assets with the seed constant `AS_OF =
'2026-07-06'` — so every asset looked equally fresh and this feature was
**structurally unable to fire**. It also meant `computeCurrentValue` accrued
saving-deposit interest to a frozen date.

All production read paths now use `todayInTimeZone()` (`Asia/Ho_Chi_Minh`), and
`valueUpdatedAt` is read from the row. `AS_OF` survives only in
`common/seed/money-space.seed.ts` for seeding.

## Where it lives in code

- **backend**: `src/common/utils/freshness.ts` (pure: `staleAfterDaysFor`,
  `freshnessOf`), `AssetsService.getDataFreshness` / `.confirmAssetsUnchanged`.
  The forecast surfaces the same fact as the `stale_asset_values` assumption and
  `staleAssetIds`; [[attention-items]] turns it into a `stale_data` signal.
- **frontend-web**: `src/features/freshness/` (pending).

## Routes

```
GET  /households/:hid/assets/data-freshness     → { counts, oldestDaysSinceUpdate, needsAttention, items }
POST /households/:hid/assets/confirm-unchanged  (edit)  body: { assetIds?: string[] }
```

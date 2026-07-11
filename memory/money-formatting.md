# Money formatting — API returns raw numbers

The API returns **raw numeric VND amounts only**; it never returns pre-formatted
money strings like `"3,4M"` / `"+3,4M"`. **The client formats for display.**
Related: [[assets]], [[dashboard]], [[money-events]], [[goals]], [[debts]].

## Rule

- Every money value in an API response is a **number** (VND). No `*Display`
  field, no `formatCompactMillions` on the backend.
- The DB already stores raw `Decimal(14,2)` — there were never formatted columns;
  the formatting used to happen in the response builders and was removed.

## What changed (2026-07-10)

Removed the `formatCompactMillions` helper and every formatted-string field it fed:

- `toMoneyEventCard` — dropped the `"+3,4M"` string; `amount` is now the raw
  **signed** number (inflow > 0, outflow < 0). No more `amountValue`.
- `toPaymentCard` — `amount` is the raw number (was a formatted string +
  `amountValue`).
- `toGoalCard` — dropped `current` / `target` strings; keeps numeric
  `currentAmount` / `targetAmount`.
- `assets.service` — dropped `currentValueDisplay` (asset records) and
  `valueDisplay` (summary groups); keeps numeric `currentValue` / `value`.
- `dashboard.service` snapshot — `liquid`, `liquidSplit.cash/account`, `savings`,
  `debt`, `netWorth` are all raw numbers (dropped `liquidDisplay`,
  `netWorthDisplay`, and the ad-hoc `liquid` string); `assetGroups[].value` is a
  raw number.

Note: date **labels** (`date`, `due`, `updatedAt` via `formatDateLabel`) are a
separate concern and were left as-is — this change is about money values only.

## Frontend side (frontend-web)

Formats with `formatVndShort` (`src/shared/lib/format-money.ts`, the `"3,4M"`
style) and `formatVndSigned` (`"+3,4M"` / `"-3,4M"`) for signed money-event
amounts. See the session log `session/2026-07-10/api-raw-money-numbers/`.

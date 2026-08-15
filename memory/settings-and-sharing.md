# Settings & sharing

Household preferences and reminders. Related: [[sharing-levels]],
[[members-and-lifecycle-safeguard]], [[households-and-onboarding]].

## Overview

Household config plus the sharing controls that let the money-holder avoid feeling surveilled (see [[domain-overview]] tone).

## Household config

- Household name (≤ 60 chars).
- `currency` is an ISO-4217 3-letter code validated against the **`currencies`
  reference table** (seeded: VND, USD, EUR, THB, JPY, GBP, AUD, SGD, CNY, KRW;
  extend by inserting a row). Every `currency`/`baseCurrency`/`quoteCurrency`
  column has a DB FK to `currencies(code)`. This replaced the three conflicting
  hardcoded enum sets across onboarding/settings. Snapshot totals are in
  `household.currency`.
- `updateFrequency = weekly | biweekly | monthly`.
- App language.

## Reminders

Two toggles:
- `reminderPayments` — upcoming-payment reminders.
- `reminderUpdate` — weekly/monthly snapshot-update reminder.

## There are no household-level sharing controls

`shareAssets`, `shareUpcoming` and `hidePrivateNotes` were **removed**, and the
`SharingCard` with them. Three reasons, strongest first:

1. **They never persisted.** `updateHouseholdConfig` PATCHes only `currency`, so
   the user's choice was silently discarded. In a product whose proposition is
   "you decide what to share", a sharing control that lies is the worst bug
   available.
2. **A household-scoped default is the wrong shape.** One partner setting a
   policy for both is structurally the asymmetry this model removes at the
   record level. Sharing is chosen per record, by whoever is looking at it.
3. `hidePrivateNotes` had no referent once `private` was gone.

The default for a new record is the code constant `DEFAULT_VISIBILITY_LEVEL`
(`detail`). If a persisted household default is ever genuinely wanted, it must be
ONE control backed by a real column and a real PATCH — not three against an
endpoint that ignores them. See [[sharing-levels]].

## Data controls

Export / delete data (a spec risk-mitigation requirement — the money-holder must be able to leave with their data).

## Where it lives in code

- **frontend-web**: `src/features/settings/{model/settings-form.ts, hooks/use-settings-page.ts, ui/...}`.
- **backend**: household fields on the `households` table; sharing enforced via visibility levels / RLS.
- **mobile-app**: to be ported.

## Enums

`SharingLevel = overview | grouped | detailed`, settings `currency = VND | USD | EUR`, `updateFrequency = weekly | biweekly | monthly`.

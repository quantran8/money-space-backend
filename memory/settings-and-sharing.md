# Settings & sharing

Household preferences, reminders, and the flexible privacy/sharing model. Related: [[members-and-permissions]], [[households-and-onboarding]].

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

## Sharing / privacy controls

- `shareAssets` and `shareUpcoming`, each ∈ `SharingLevel = overview | grouped | detailed` — the spec's flexible view-permission model.
- `hidePrivateNotes` toggle.
- These map onto the per-entity `VisibilityLevel` and the member permission levels (see [[members-and-permissions]]).

## Data controls

Export / delete data (a spec risk-mitigation requirement — the money-holder must be able to leave with their data).

## Where it lives in code

- **frontend-web**: `src/features/settings/{model/settings-form.ts, hooks/use-settings-page.ts, ui/...}`.
- **backend**: household fields on the `households` table; sharing enforced via visibility levels / RLS.
- **mobile-app**: to be ported.

## Enums

`SharingLevel = overview | grouped | detailed`, settings `currency = VND | USD | EUR`, `updateFrequency = weekly | biweekly | monthly`.

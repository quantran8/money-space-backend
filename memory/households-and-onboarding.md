# Households & onboarding

Creating the shared finance space and getting both partners in. Related: [[members-and-permissions]], [[auth]], [[settings-and-sharing]].

## Overview

A `Household` is the aggregate root (see [[domain-overview]]). Onboarding creates one and optionally invites a partner. Gating: `RequireAuth` → `RequireHousehold` → `AppShell`. A user with no household is forced to `/onboarding`.

## Create-household flow (transactional)

1. Upsert the owner's profile.
2. Create the household.
3. Create the creator as a member with role `owner` + permission `admin` (see [[members-and-permissions]]).
4. Optionally create a pending `HouseholdInvite` (7-day TTL, random token; defaults partner / view_detail).
5. Write an `household.created` audit log with `{ invitedPartner }` metadata.

## Validation

- `name` required (frontend ≤ 40 chars; settings allows ≤ 60).
- `currency` ∈ `{ VND, USD, THB }`, default VND. (Settings currency options differ: `VND | USD | EUR` — a known inconsistency to reconcile.)
- Optional partner-invite email validated **only when non-empty** (regex).
- `updateFrequency` must be weekly / monthly / manual (backend falls back to `manual`).

## Active household

The active household id is kept in a zustand `household-store`; `use-my-households` lists memberships; `use-active-household` resolves the current one.

## Invite state machine

`HouseholdInvite`: pending → accepted / expired / cancelled. Unique token, expiry, default role/permission for the invitee. (Accept flow not yet exposed via a controller — only creation on household-create.)

## Where it lives in code

- **frontend-web**: `src/features/onboarding/{model/onboarding-form.ts, hooks/use-my-households.ts, hooks/use-onboarding-page.ts, api/onboarding.repository.ts, ui/require-household.tsx}`, `src/shared/stores/household-store.ts`, `src/shared/hooks/use-active-household.ts`.
- **backend**: `src/modules/households/` (`households.service.ts`, `repositories/prisma-households.repository.ts`).
- **mobile-app**: to be ported.

## Enums

`HouseholdCurrency = VND | USD | THB`, `InviteStatus = pending | accepted | expired | cancelled`, `updateFrequency = weekly | monthly | manual`.

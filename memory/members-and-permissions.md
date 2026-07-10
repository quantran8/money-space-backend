# Members & permissions

Household membership, roles, sharing permissions, and invites. Related: [[households-and-onboarding]], [[settings-and-sharing]].

## Roles & permission levels

- **Roles**: `owner | partner | viewer`.
- **Permission levels**: `view_summary | view_grouped | view_detail | edit_content | admin`.

## Default permission per role (`defaultPermissionForRole` / `DEFAULT_PERMISSION_FOR_ROLE`)

| Role | Default permission |
|---|---|
| owner | `admin` |
| partner | `edit_content` |
| viewer | `view_summary` |

## Rules / invariants

- On member **create**: compute `initials` (from name/email), default `permission` from role, default status `invited`.
- On member **update**: changing `role` **re-derives** `permission` unless permission is explicitly provided.
- **Owner member cannot be deleted** (`BadRequestException`).
- **Invites** can only assign `partner` or `viewer` (never `owner`). Invite email must be valid and **must not duplicate** an existing member.
- Member status: `active | invited`.

## Visibility / sharing

`VisibilityLevel = summary_only | grouped | detail | private` is a per-entity sharing control that drives the privacy model and RLS. See [[settings-and-sharing]].

## Where it lives in code

- **frontend-web**: `src/features/members/{model/members.ts, model/members.types.ts, model/members-form.ts, api/members.repository.ts, hooks/...}`.
- **backend**: `src/modules/members/` (`members.service.ts`, `entities/member.entity.ts`, `repositories/prisma-members.repository.ts`). Join table `household_members` unique on `[householdId, userId]`.
- **mobile-app**: to be ported.

## Enums

`HouseholdRole = owner | partner | viewer`, `PermissionLevel = view_summary | view_grouped | view_detail | edit_content | admin`, `VisibilityLevel = summary_only | grouped | detail | private`, member status `active | invited`.

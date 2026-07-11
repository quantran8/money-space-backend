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

## Enforcement (app-layer, NOT Postgres RLS — DB-portable)

Two guards registered globally via `APP_GUARD` in `AuthModule`:
- **`SupabaseAuthGuard`** — authenticates every route (populates `req.user`).
  Skipped for routes marked `@Public()` (auth signup/login/google/refresh +
  worker accrue-interest endpoints).
- **`HouseholdAccessGuard`** — on `/api/households/:householdId/*`, verifies the
  user is a live member, attaches `req.membership` (`role`, effective
  `permission`, `isOwner`), and enforces the route's `@RequireCapability(...)`.

**Capability model** (`money-space.utils.ts`):
- `effectivePermission(role, override)` = override ?? `defaultPermissionForRole`.
- `@RequireCapability('edit')` on all create/update/delete routes (assets, debts,
  goals, payments, money-events, snapshots); `@RequireCapability('admin')` on
  member management. Read routes need no decorator (any member may read;
  visibility is gated per-record).
- `canEdit` = permission ≥ `edit_content`; `canAdmin` = `admin`.

**Visibility model** (`canViewVisibility`): `visible = viewer.tier ≥ record.tier
AND (record ≠ private OR viewer is creator/admin)`. Tiers: summary_only < grouped
< detail; `private` = creator/admin only. `@CurrentMembership()` decorator exposes
the membership to handlers for per-record filtering.

## Rules / invariants

- **`permissionLevel` is a nullable OVERRIDE** (both on `household_members` and
  `household_invites.defaultPermissionLevel`): NULL = derive from role
  (`defaultPermissionForRole`: owner→admin, partner→edit_content, viewer→view_summary).
  Role is the primary capability axis; the column is only set when a member needs
  a permission differing from their role default. `mapMember` derives on read when
  the DB value is NULL. Enforcement is **app-layer** (not RLS — see the DB-portable
  decision). This is the "2-axis" model: role/capability + record visibility tier.
- On member **create**: compute `initials` (from name/email), default `permission` from role, default status `invited`.
- On member **update**: changing `role` **re-derives** `permission` unless permission is explicitly provided.
- **Owner member cannot be deleted** (`BadRequestException`).
- **Invites** can only assign `partner` or `viewer` (never `owner`). Invite email must be valid and **must not duplicate** an existing member.
- Member status: `active | invited` — now a **persisted column** on `household_members` (`MemberStatus` enum), not hardcoded. Set on create (default `invited`), read back by `mapMember`. Removing a member **soft-deletes** (`deletedAt`) rather than hard-deletes, so audit logs and owned assets/debts keep their FK references; all member queries filter `deletedAt IS NULL`.

## Visibility / sharing

`VisibilityLevel = summary_only | grouped | detail | private` is a per-entity sharing control that drives the privacy model and RLS. See [[settings-and-sharing]].

## Where it lives in code

- **frontend-web**: `src/features/members/{model/members.ts, model/members.types.ts, model/members-form.ts, api/members.repository.ts, hooks/...}`.
- **backend**: `src/modules/members/` (`members.service.ts`, `entities/member.entity.ts`, `repositories/prisma-members.repository.ts`). Join table `household_members` unique on `[householdId, userId]`.
- **mobile-app**: to be ported.

## Enums

`HouseholdRole = owner | partner | viewer`, `PermissionLevel = view_summary | view_grouped | view_detail | edit_content | admin`, `VisibilityLevel = summary_only | grouped | detail | private`, member status `active | invited`.

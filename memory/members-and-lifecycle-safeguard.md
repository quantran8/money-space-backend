# Members & the lifecycle safeguard

Who is in a household, and the one thing that is not open to everyone. Related:
[[households-and-onboarding]], [[invites]], [[activity-log]], [[auth]].

## The model

**Two partners are equal in everything that touches the money.** Any live member
may read and write any record in their household — assets, debts, events, goals,
events — and may change any record's sharing level. There is no role, no
permission tier, and no approval flow between them.

What makes a change accountable is **the journal entry it leaves**, not a
permission that was granted beforehand. See [[activity-log]].

There is deliberately no `HouseholdRole` and no `PermissionLevel`. Both enums and
their columns were dropped (`20260815120200`, `20260815130000`). Do not
reintroduce a role column "just as a label": the previous one was decorative in
name only and had already misled a real check.

## The single exception

Three operations are not about money. Each either cannot be undone or changes
who is in the room:

```
delete the household
remove a member
invite a member
```

They are restricted to **whoever created the household**, resolved from
`households.created_by` — a column that already existed, that nothing renders,
and that therefore keeps hierarchy vocabulary out of the UX entirely.

- Marker: `@RequireHouseholdCreator()`
  (`src/modules/auth/decorators/require-household-creator.decorator.ts`).
- Enforced in `HouseholdAccessGuard`, which already loads the household row.
- `req.membership` is `{ householdId, userId, isCreator }`. Nothing else.

Routes that are **not** gated, and why:

| route | reasoning |
|---|---|
| `PATCH /members/:id` | only edits name / email / initials now |
| `GET /invites` | reading a pending list is not a lifecycle change |
| `DELETE /invites/:id` | reversible; gating it would stop a partner cancelling an invitation they believe is a mistake |

## The creator cannot be removed

`MembersService.deleteMember` refuses when
`member.profileId === household.createdBy`.

This is structural, not a courtesy. The guard resolves the safeguard from a
**live** membership row, so deleting the creator's row would leave a household
where nobody can invite or remove anyone, permanently. Pinned by
`members.service.spec.ts`, including that a stale `role: 'owner'` is *not*
treated as the safeguard.

To hand it over: `POST /api/households/:householdId/transfer-steward`
(`{ toUserId }`, creator-only, audited). There is deliberately **no** `/leave`
endpoint — adding one before transfer existed would recreate the lock-out.

## Not permissions

`households.financial_management_mode` is personalization and analytics only. It
must never appear in an authorization path.

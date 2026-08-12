# Protected reserves

Money the household has decided to keep untouched (spec §19C). Related:
[[forecast-and-flexible-money]], [[cashflow-events]], [[assets]].

## What it is — and what it is not

A reserve is a **constraint on the forecast, not an account**. Nothing is moved
anywhere; no asset is earmarked, no balance is locked. Declaring a 50M emergency
fund does not create a 50M asset — it says "when you tell me how much is free to
spend, subtract this first".

That is why it is its own table rather than a flag on an asset. The money can sit
across three bank accounts, or in the same account as everyday spending. What the
household is recording is a **decision**, not a location.

## The one rule

`flexibleMoney = <liquid figure> − Σ active reserves`

Only `active` reserves are subtracted. `archived` keeps the record and its
history without letting it distort today's picture — which is the whole reason
archiving exists instead of deleting: "we used to protect this" is worth keeping.

## Validation

- `amount >= 0`. A negative reserve has no meaning, and if one ever reached the
  forecast it would silently **increase** flexible money — the opposite of what
  the feature is for.
- `name` required. The UI shows one main reserve, but the schema supports many;
  an unnamed one is unusable the moment there are two.

## Schema shape

The MVP UI exposes a single reserve. The table supports many deliberately, so
adding a second is a UI change, not a migration.

Mirrored index note: the partial `protected_reserves_household_live_idx
(household_id) WHERE deleted_at IS NULL` is mirrored by
`@@index([householdId, deletedAt])` in `schema.prisma`, so a future Prisma
re-init squash cannot silently drop the lookup (this has happened before — see
[[assets]]).

## Where it lives in code

- **backend**: `src/modules/protected-reserves/` (CRUD; single-statement writes,
  no transaction — one statement, one table). The forecast does NOT go through
  this service: `PrismaForecastRepository.loadForecastBundle` reads reserves in
  its own parallel fan-out, keeping `ForecastModule` free of another dependency
  edge.
- **frontend-web**: `src/features/reserves/` (pending).

## Routes

```
GET    /households/:hid/protected-reserves        → { items, total, activeTotal }
POST   /households/:hid/protected-reserves        (edit)
PATCH  /households/:hid/protected-reserves/:id    (edit)
DELETE /households/:hid/protected-reserves/:id    (edit)
```

`activeTotal` is returned alongside the list so the client never re-derives —
and therefore never disagrees with — the number the forecast subtracts.

# Feedback (Báo lỗi / Góp ý)

## Overview

One person's message to whoever builds the app — a bug they hit, or something
they wish it did. Submitted from a card in Settings (web) / a section in the Gia
đình tab (mobile), stored in Postgres, and read by the developer in the Supabase
dashboard.

It is the only feature in the app with no reader inside the app.

## Rules / flow

1. The user picks a type (`bug` | `idea` | `other`) and writes a message.
2. The client attaches context without asking: the route they were on, the
   platform, the app version, the locale, and (web only) the browser user agent.
3. `POST /api/v1/feedback` stores one row. The response is `{ submitted, feedbackId }`.
4. Nothing else happens. No email, no webhook, no in-app notification.

### Why Postgres-only, with no notification channel

The backend has no email or messaging infrastructure of any kind — no Resend, no
nodemailer, no Slack or Telegram webhook. Adding one for this feature would mean
a provider account, an API key, a failure mode to handle, and a second system to
keep alive. The first hundred reports do not need any of that: the developer is
the only reader, and the Supabase dashboard already has authentication, a table
editor, sorting and filtering.

This is a deliberate MVP choice, not a stopgap that is waiting to be fixed. The
thing to revisit is not "add email" but "is anyone failing to read these".

### Why it is NOT household-scoped

Every other resource lives under `households/:householdId/*`, because everything
else in the product is jointly owned — membership *is* the permission, and either
partner may read and edit anything in the space.

Feedback is the opposite of that in two ways:

- **A report is written by a person, not by a space.** Filing it under the
  household would imply the partner can see it, which is a promise the product
  does not keep (there is no read endpoint at all) and a framing the voice
  avoids.
- **The report that matters most comes from someone with no household.**
  Onboarding, the `/join` screen, or a gate that keeps redirecting are exactly
  the states where a user most needs to report something — and exactly the
  states where `activeHouseholdId` is `null`. Under a household-scoped path
  those users have no URL to post to. That would be a bug-report button that
  cannot report the bug blocking you.

`household_id` is therefore stored as an optional **context hint** with no
foreign key: a report about a household that was later deleted must still
insert, and must still be there afterwards.

**Authorization consequence.** `HouseholdAccessGuard` returns `true` — not 403 —
for any route with no `:householdId` param, so this route is authenticated by
`SupabaseAuthGuard` but carries no household authorization. That is not a hole,
because there is no household-owned resource to read: the service takes the
actor from the bearer token (`@CurrentUser`) and trusts nothing in the body. The
DTO deliberately has no user field.

A second consequence: with no `:householdId` in the path,
`CacheInvalidationInterceptor` never fires, so `@NoCacheInvalidation()` is not
needed here. Adding it would imply a household path exists.

### Why `context` is jsonb and not columns

Nothing queries inside the bag — the entire read path is a human scrolling the
table editor — so the usual case for discrete columns (indexable, typed,
joinable) buys nothing. And the vocabulary is the *client's*: web reports a
browser user agent and a router path, mobile may later want an OS version or a
device model. A column per field would mean a backend migration every time a
client learns to report one more thing about itself, which is a tax on exactly
the diagnostic richness the feature wants.

`user_id`, `email` and `household_id` are the exceptions that do get real
columns: they are identity, they are read at a glance, and `user_id` is indexed
for the rate check. `email` is denormalized from the token so a row is readable
without a join and survives the profile being deleted.

### Why append-only

No `deleted_at` and no `updated_at`, the same exception `audit_logs` and
`profiles` take. A submitted report is a historical fact; nothing in the app can
edit or remove one, there is one writer and no app-side reader. A soft-delete
column would only be a filter every future reader has to remember for no gain.

For the same reason the standard `@@index([householdId, deletedAt])` is absent —
it serves per-household list queries, of which there are none. The two indexes
that exist serve the only access patterns that are real: newest-first in the
dashboard, and the per-user rate check.

### Why there is no GET endpoint

A list endpoint would need an authorization rule this codebase does not have.
There is no admin role and no superuser — see
[[members-and-lifecycle-safeguard]] — so `GET /feedback` could only ever mean
"your own reports", which serves no user need (nobody re-reads their own bug
reports) while costing an endpoint, a query key, a hook and a UI.

### Why it is NOT in the activity journal

`AuditService.record` requires a non-null `householdId`, which a report may not
have. More fundamentally, the journal exists so that a change to the household's
**shared money picture** is accountable to the partner — see [[activity-log]].
A bug report moves no figure and is not the partner's business. Do not add a
`feedback.submitted` action.

### Validation and abuse

All validation is hand-written in the service (this repo uses plain-interface
DTOs and no `ValidationPipe`):

- `type` must be one of `bug` / `idea` / `other`.
- `message` is trimmed, required, and capped at 2000 characters — matching the
  `feedback_message_not_empty` CHECK constraint.
- `context` is sanitized rather than parsed: string/number/boolean leaves only,
  each string capped at 500 characters, at most 20 keys, 4000 bytes total. The
  sanitizer does not know the key names on purpose.
- A loose rate limit of 20 reports per user per hour. Deliberately generous: the
  endpoint is authenticated, so the realistic failure is a client retry loop,
  not a person. A tight limit would reject the second honest report of a bad
  afternoon.

**The message is never logged.** The service logs only the type and the length.
It is the user's own words, and the log is not where they agreed to put them.

## Where it lives in code

**backend**
- `prisma/schema.prisma` — `Feedback` model + `FeedbackType` enum
- `prisma/migrations/20260911090000_feedback/migration.sql`
- `src/modules/feedback/` — controller, service, dto, entity, repositories
- Registered in `src/modules/money-space.module.ts`

> The CHECK constraint is not created by `prisma db push` (Prisma cannot express
> one). It must be applied by hand in the Supabase SQL editor after
> `npm run db:init`, or the service validation is the only enforcement.

**frontend (shared core)**
- `packages/core/src/features/feedback/api/feedback.repository.ts`
- `packages/core/src/features/feedback/hooks/use-feedback.ts` — gathers the
  context for both clients so they cannot drift apart
- `packages/core/src/features/feedback/model/feedback-form.ts`
- `packages/core/src/shared/api/env.ts` — `platform` and `appVersion` injected
  by each host app

**web** — `web/src/features/settings/ui/components/feedback-card.tsx` and
`feedback-dialog.tsx`, mounted in `settings-page.tsx`.

**mobile** — `mobile/src/features/settings/ui/feedback-section.tsx` and
`feedback-sheet.tsx`, mounted in `app/(tabs)/household.tsx`.

## Known gap

Both entry points sit behind the `RequireHousehold` gate, so a user who has no
household yet cannot currently reach the form — even though the endpoint
deliberately accepts them. Closing it is cheap when wanted: a text link on the
onboarding screen opening the same dialog. The hook already handles
`activeHouseholdId === null`.

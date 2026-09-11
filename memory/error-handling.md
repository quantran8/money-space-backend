# Error handling

**A thrown `message` is a diagnostic. The client never displays it.**

## What went wrong before

The client showed the server's own `message` on every failed action. The user —
Vietnamese, non-technical — read things like:

- `amount must be a positive number`
- `Household "3f2a8c1e-…" was not found` (an internal id, on screen)
- `Invalid or expired session (JWSSignatureVerificationFailed)`
- Supabase's raw login error, which distinguishes "no such user" from "wrong
  password" — an account-enumeration oracle handed to anyone with a form.

The copy to prevent this was already written: every call site passed a proper
Vietnamese sentence to `getErrorMessage(error, t('…Failed'))`. But the helper
returned `error.message` whenever it existed, and an `ApiError` always has one —
so the translated fallback was dead code on the API path. Roughly 54 surfaces,
~77% of user-visible API errors, showed the server's string.

## The rule

Three layers, each with one job:

| Layer | Carries | Audience |
| --- | --- | --- |
| `message` | what actually broke, in English | the log, Grafana, a developer |
| `code` | a stable machine-readable reason | the client, to decide behaviour |
| i18n copy | one calm sentence | the user |

The user-facing sentence is `common.genericError` — *"Đã có lỗi xảy ra, vui lòng
thử lại sau."* One line for every failure, deliberately: a per-action message is
only worth writing when the user can act differently on it, and today they
cannot. `getErrorMessage(error, fallback)` returns the caller's `fallback` and
logs the cause to the console; it never reads `error.message`.

## When to add a `code`

Only when a client would **behave** differently — open the paywall, send the
user back to sign in, offer a cascade-delete confirmation. An ordinary refusal
needs no code; the default copy covers it. That is why the catalog in
`src/common/errors/error-code.ts` has ~13 entries and not one per throw site:
218 constants that all map to the same sentence would be ceremony, not safety.

Throw with the helpers in `src/common/errors/coded.exceptions.ts`. They subclass
the ordinary Nest exceptions (`ForbiddenException`, `UnauthorizedException`, …)
rather than `HttpException` directly, so every existing `instanceof` check and
test keeps holding — the code is purely additive.

## The filter forwards a whitelist

`HttpExceptionFilter` copies only named keys out of the exception payload.
Anything not on that list is **silently dropped** — which is how `code`,
`trial.reason` and the asset-delete `impact` block were all being thrown by
services and never reaching the client. If a new structured field must reach the
client, add it to `ErrorBody` *and* to the spread in `catch()`. Both, or it
disappears without an error.

## 5xx detail is allow-listed, not deny-listed

The generic-message switch is `NODE_ENV === 'development' | 'test'`, not
`!== 'production'`. An unset or misspelled `NODE_ENV` on a deployed box must fail
closed; the previous form would have started echoing raw Prisma errors at any
environment that was not exactly `production`.

The full message and stack always go to the log, in every environment.

## Frontend

`ApiError` carries `statusCode`, `code`, and `premium`. Two consumers read a
reason rather than copy: the 402 paywall (`premium.reason`) and redeem codes
(`code`, falling back to `message` until those throw sites send one). Everything
else shows `common.genericError`.

# Auth

Authentication & session gating. Supabase-backed. Related: [[households-and-onboarding]], [[members-and-lifecycle-safeguard]].

## Overview

Email/password + Google OAuth, backed by Supabase. Session gating chains `RequireAuth` → `RequireHousehold` → `AppShell` (see [[households-and-onboarding]]).

## Rules / flow

- **Email/password** signup & login; **Google OAuth** (callback route consumes the OAuth code, then exchanges it).
- Emails are **normalized to lowercase**.
- On every signup / login / Google callback, the backend **upserts a `profiles` row** mirroring the auth user (`profile.id = auth uid`). `Profile` is the author (`created_by` / `updated_by`) on virtually every entity.
- Refresh + logout supported; logout revokes refresh tokens via the admin client when available.
- Token validation prefers **local JWKS verification** (no network) via `TokenVerifierService`, falling back to Supabase `getUser`.

## Google OAuth (PKCE, two requests)

The sign-in is split across two backend requests, which is what shapes the code:
`GET /api/auth/google` builds the authorization URL, and `POST
/api/auth/google/callback` exchanges the returned code. PKCE ties them together
with a `code_verifier` that must survive between them.

Three constraints, each learned the hard way:

- **`flowType` must be `'pkce'` explicitly.** supabase-js defaults to
  `implicit`, which returns the token in a URL *fragment* and never sends the
  `?code=` the callback route reads — the flow simply could not complete.
- **`persistSession` must be `true` on the OAuth client.** When it is `false`,
  supabase-js **ignores a supplied `storage`** and swaps in an internal
  in-memory adapter, so the verifier vanishes when the request ends. This is the
  one place the backend deviates from its otherwise stateless clients; the
  storage is ours and the client is per-request, so nothing leaks between users.
- **supabase-js emits no OAuth `state`.** We mint one (`randomUUID`) and put it
  on `redirectTo`, whose query string Supabase preserves; the callback sends it
  back and it is the key the verifier is stored under. Anything already on that
  URL — `next`, carrying an invite QR destination — survives alongside it.

The verifier is **single-use**: reading it retires it, so a leaked code cannot be
replayed. TTL is 10 minutes.

Storage is Redis when configured, with an in-process Map fallback. The cache is
deliberately fail-open ([[../CLAUDE.md]] "Caching"), but a lost verifier fails
the login outright rather than merely costing latency — hence the fallback, which
is why local dev and CI work with no Redis at all. Only the Redis path is correct
across multiple instances.

## Guards / middleware (backend)

- `AuthMiddleware` — **non-blocking**: populates `req.user` if a valid bearer token exists.
- `SupabaseAuthGuard` — enforces auth on protected routes.
- `@CurrentUser()` decorator injects the user.

## Where it lives in code

- **frontend-web**: `src/features/auth/{api/auth.repository.ts, api/auth-bridge.ts, hooks/use-session.ts, hooks/use-google-callback.ts, hooks/use-logout.ts, model/auth-form.ts, ui/require-auth.tsx}`, `src/shared/stores/auth-store.ts`.
- **backend**: `src/modules/auth/` (`auth.service.ts`, `oauth-verifier.store.ts`, `token-verifier.service.ts`, `guards/supabase-auth.guard.ts`, `middleware/auth.middleware.ts`, `repositories/prisma-auth.repository.ts`).
- **mobile-app**: to be ported.

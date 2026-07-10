# Auth

Authentication & session gating. Supabase-backed. Related: [[households-and-onboarding]], [[members-and-permissions]].

## Overview

Email/password + Google OAuth, backed by Supabase. Session gating chains `RequireAuth` → `RequireHousehold` → `AppShell` (see [[households-and-onboarding]]).

## Rules / flow

- **Email/password** signup & login; **Google OAuth** (callback route consumes the OAuth code, then exchanges it).
- Emails are **normalized to lowercase**.
- On every signup / login / Google callback, the backend **upserts a `profiles` row** mirroring the auth user (`profile.id = auth uid`). `Profile` is the author (`created_by` / `updated_by`) on virtually every entity.
- Refresh + logout supported; logout revokes refresh tokens via the admin client when available.
- Token validation prefers **local JWKS verification** (no network) via `TokenVerifierService`, falling back to Supabase `getUser`.

## Guards / middleware (backend)

- `AuthMiddleware` — **non-blocking**: populates `req.user` if a valid bearer token exists.
- `SupabaseAuthGuard` — enforces auth on protected routes.
- `@CurrentUser()` decorator injects the user.

## Where it lives in code

- **frontend-web**: `src/features/auth/{api/auth.repository.ts, api/auth-bridge.ts, hooks/use-session.ts, hooks/use-google-callback.ts, hooks/use-logout.ts, model/auth-form.ts, ui/require-auth.tsx}`, `src/shared/stores/auth-store.ts`.
- **backend**: `src/modules/auth/` (`auth.service.ts`, `token-verifier.service.ts`, `guards/supabase-auth.guard.ts`, `middleware/auth.middleware.ts`, `repositories/prisma-auth.repository.ts`).
- **mobile-app**: to be ported.

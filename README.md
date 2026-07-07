# Money Space Backend

NestJS backend for Money Space with:

- domain-based API modules under `src/money-space`
- `Prisma` client setup under `src/database/prisma`
- `Supabase` client setup under `src/database/supabase`

## Environment

Copy `backend/.env.example` to `backend/.env` and replace the placeholder values.

Required variables:

- `DATABASE_URL`
- `DIRECT_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## Schema Workflow

The canonical SQL schema currently lives at:

- `frontend-web/supabase/migrations/20260705223000_init_money_space.sql`

Prisma mirrors that schema in:

- `backend/prisma/schema.prisma`

Typical workflow:

```bash
pnpm prisma validate
pnpm prisma generate
pnpm prisma db pull
```

## Run

```bash
pnpm run start:dev
```

## Verify

```bash
pnpm run test
pnpm run test:e2e
pnpm run build
```

# Supabase Schema Source

The canonical SQL schema for Money Space currently lives in:

- `frontend-web/supabase/migrations/20260705223000_init_money_space.sql`

This backend is set up to use that same Supabase Postgres database through:

- `prisma/schema.prisma` for the typed Prisma client
- `src/database/supabase/supabase.service.ts` for direct Supabase API access

Recommended workflow:

1. Apply or update SQL schema in the Supabase migration file above.
2. Run `npm run prisma:db:pull` if you want Prisma to introspect from a live database.
3. Run `npm run prisma:generate`.

Environment variables are documented in `backend/.env.example`.

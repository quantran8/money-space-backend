-- v3.1 §16: rename `asset_value_history` back to `asset_valuations`.
--
-- The table was originally `asset_valuations`; 20260712120000 renamed it to
-- `asset_value_history`. The v3.1 spec names it `asset_valuations`, and the
-- "full alignment" pass restores that. RENAME preserves every row.
--
-- IMPORTANT — why the rename list below is short:
-- Renaming a table in Postgres does NOT rename its indexes or constraints, and
-- 20260712120000 only renamed TWO indexes. So the primary key, the original
-- foreign keys, the partial live index and the CHECK constraint STILL carry
-- their original `asset_valuations_*` names and snap back into correctness for
-- free. Only the six objects that were explicitly renamed/created with the
-- `asset_value_history_` prefix need renaming here.
--
-- Prisma detects drift by comparing these names against what it would generate
-- from schema.prisma, so missing one would make the next `migrate dev` emit a
-- spurious drop/recreate.

-- Rename the table (data preserved). Guarded so a retry after a partially
-- applied migration is a no-op rather than a hard failure.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'asset_value_history'
  ) THEN
    ALTER TABLE "asset_value_history" RENAME TO "asset_valuations";
  END IF;
END $$;

-- Rename every index and constraint that still carries the old prefix. Written
-- as a catalog-driven loop rather than six literal statements so it is
-- idempotent and also fixes environments built by `prisma db push` instead of
-- this migration chain.
--
-- Objects covered: the two indexes renamed by 20260712120000, the money-event
-- index + FK it created, and the two partial-unique indexes from 20260712130000.
DO $$
DECLARE
  obj RECORD;
BEGIN
  FOR obj IN
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relkind = 'i'
       AND c.relname LIKE 'asset_value_history%'
  LOOP
    EXECUTE format(
      'ALTER INDEX %I RENAME TO %I',
      obj.name,
      replace(obj.name, 'asset_value_history', 'asset_valuations')
    );
  END LOOP;

  FOR obj IN
    SELECT con.conname AS name
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'asset_valuations'
       AND con.conname LIKE 'asset_value_history%'
  LOOP
    EXECUTE format(
      'ALTER TABLE "asset_valuations" RENAME CONSTRAINT %I TO %I',
      obj.name,
      replace(obj.name, 'asset_value_history', 'asset_valuations')
    );
  END LOOP;
END $$;

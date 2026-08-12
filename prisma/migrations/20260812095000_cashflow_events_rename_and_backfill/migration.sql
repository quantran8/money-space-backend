-- v3.1 §18: `upcoming_payments` becomes `cashflow_events`.
--
-- This is the structural centre of v3.1. The old table could only express money
-- going OUT ("a bill to pay"). The forecast needs one unified timeline of money
-- moving in BOTH directions, with how certain it is and whether it is optional —
-- otherwise there is no running balance, no lowest projected balance, and no
-- flexible money. Spec §2.9 explicitly rejects a separate `upcoming_incomes`
-- table in favour of this single timeline.
--
-- Recurrence stays a RULE on one row: `expected_date` is the current occurrence
-- and the forecast expands future ones virtually (§2.15). Future rows are never
-- pre-created, so `auto_create_next` is dropped.
--
-- BREAKING: the `/upcoming-payments` API is replaced, not aliased. The payload
-- shape changes (dueDate → expectedDate, plus direction/certainty/requirement),
-- so a silent alias would be worse than a clean break.
--
-- DEPLOY TOGETHER WITH THE CODE. `recomputeSnapshotTotals` contains raw SQL
-- reading `FROM upcoming_payments ... status = 'unpaid'`, and the auto-snapshot
-- hooks swallow errors — so a migration-first deploy would not fail loudly, it
-- would silently stop updating snapshots. That method is deleted in the same
-- change set.

-- ----------------------------------------------------------------------------
-- 1. Enums.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CashflowDirection') THEN
    CREATE TYPE "CashflowDirection" AS ENUM ('incoming', 'outgoing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CashflowRequirement') THEN
    CREATE TYPE "CashflowRequirement" AS ENUM ('required', 'planned');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CashflowCertainty') THEN
    CREATE TYPE "CashflowCertainty" AS ENUM ('confirmed', 'estimated');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CashflowEventStatus') THEN
    CREATE TYPE "CashflowEventStatus" AS ENUM (
      'expected', 'completed', 'pending_confirmation',
      'postponed', 'overdue', 'cancelled'
    );
  END IF;
  -- Same five values, better name now that it describes a recurrence rule
  -- rather than a payment schedule.
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentFrequency')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RecurrenceFrequency') THEN
    ALTER TYPE "PaymentFrequency" RENAME TO "RecurrenceFrequency";
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Table + column renames (all data preserved).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'upcoming_payments'
  ) THEN
    ALTER TABLE "upcoming_payments" RENAME TO "cashflow_events";
  END IF;
END $$;

DO $$
DECLARE
  col RECORD;
BEGIN
  FOR col IN SELECT * FROM (VALUES
    ('due_date',           'expected_date'),
    ('frequency',          'recurrence'),
    -- paid_* become last_completed_*: for a RECURRING series these describe the
    -- most recent completion, not a terminal state, because the row lives on
    -- and its expected_date advances to the next occurrence.
    ('paid_at',            'last_completed_at'),
    ('paid_by',            'last_completed_by'),
    ('paid_amount',        'last_completed_amount'),
    ('paid_from_asset_id', 'last_completed_asset_id')
  ) AS t(old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'cashflow_events'
         AND column_name = col.old_name
    ) THEN
      EXECUTE format('ALTER TABLE "cashflow_events" RENAME COLUMN %I TO %I',
                     col.old_name, col.new_name);
    END IF;
  END LOOP;
END $$;

-- Recurrence is projected virtually across the horizon; rows are never
-- pre-created, so this flag has no meaning any more (§2.15).
ALTER TABLE "cashflow_events" DROP COLUMN IF EXISTS "auto_create_next";

-- ----------------------------------------------------------------------------
-- 3. New columns — nullable first so the backfill can run.
-- ----------------------------------------------------------------------------
ALTER TABLE "cashflow_events"
  ADD COLUMN IF NOT EXISTS "direction"               "CashflowDirection",
  ADD COLUMN IF NOT EXISTS "requirement"             "CashflowRequirement",
  ADD COLUMN IF NOT EXISTS "certainty"               "CashflowCertainty",
  ADD COLUMN IF NOT EXISTS "recurrence_end_date"     DATE,
  ADD COLUMN IF NOT EXISTS "financial_goal_id"       UUID,
  ADD COLUMN IF NOT EXISTS "planned_asset_id"        UUID,
  ADD COLUMN IF NOT EXISTS "privacy_owner_member_id" UUID,
  ADD COLUMN IF NOT EXISTS "visibility_level"        "VisibilityLevel";

-- ----------------------------------------------------------------------------
-- 4. Backfill.
-- ----------------------------------------------------------------------------
-- Every legacy row was a bill the household owed. None of them could express
-- incoming money — that is the whole reason for this migration.
UPDATE "cashflow_events" SET "direction" = 'outgoing' WHERE "direction" IS NULL;

-- Debt-linked rows are contractual instalments → genuinely `required`.
-- Everything else was a user-entered expectation → `planned`, the honest
-- default: marking them all `required` would overstate obligations and make the
-- forecast look tighter than reality.
UPDATE "cashflow_events"
   SET "requirement" = CASE
         WHEN "debt_id" IS NOT NULL THEN 'required'::"CashflowRequirement"
         ELSE 'planned'::"CashflowRequirement"
       END
 WHERE "requirement" IS NULL AND "direction" = 'outgoing';

-- Legacy rows carried a concrete amount on a concrete date.
UPDATE "cashflow_events" SET "certainty" = 'confirmed' WHERE "certainty" IS NULL;
UPDATE "cashflow_events" SET "visibility_level" = 'detail' WHERE "visibility_level" IS NULL;

-- ----------------------------------------------------------------------------
-- 5. Status remap: unpaid → expected, paid → completed; the rest keep meaning.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
      JOIN pg_type t ON t.typname = c.udt_name
     WHERE c.table_schema = current_schema()
       AND c.table_name = 'cashflow_events'
       AND c.column_name = 'status'
       AND c.udt_name = 'PaymentStatus'
  ) THEN
    ALTER TABLE "cashflow_events" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "cashflow_events"
      ALTER COLUMN "status" TYPE "CashflowEventStatus"
      USING (CASE "status"::text
               WHEN 'unpaid' THEN 'expected'
               WHEN 'paid'   THEN 'completed'
               ELSE "status"::text   -- pending_confirmation / postponed / overdue
             END)::"CashflowEventStatus";
    ALTER TABLE "cashflow_events" ALTER COLUMN "status" SET DEFAULT 'expected';
    DROP TYPE IF EXISTS "PaymentStatus";
  END IF;
END $$;

-- Belt and braces for rows marked paid before paid_at was populated, so a
-- completed row always carries a completion timestamp/amount.
UPDATE "cashflow_events"
   SET "last_completed_at"     = COALESCE("last_completed_at", "updated_at"),
       "last_completed_amount" = COALESCE("last_completed_amount", "amount")
 WHERE "status" = 'completed' AND "last_completed_at" IS NULL;

-- ----------------------------------------------------------------------------
-- 6. NOT NULL + defaults, now that every row is populated.
-- ----------------------------------------------------------------------------
ALTER TABLE "cashflow_events"
  ALTER COLUMN "direction"        SET NOT NULL,
  ALTER COLUMN "certainty"        SET NOT NULL,
  ALTER COLUMN "certainty"        SET DEFAULT 'confirmed',
  ALTER COLUMN "visibility_level" SET NOT NULL,
  ALTER COLUMN "visibility_level" SET DEFAULT 'detail',
  ALTER COLUMN "recurrence"       SET DEFAULT 'once';

-- ----------------------------------------------------------------------------
-- 7. New foreign keys.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashflow_events_financial_goal_id_fkey') THEN
    ALTER TABLE "cashflow_events" ADD CONSTRAINT "cashflow_events_financial_goal_id_fkey"
      FOREIGN KEY ("financial_goal_id") REFERENCES "financial_goals"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashflow_events_planned_asset_id_fkey') THEN
    ALTER TABLE "cashflow_events" ADD CONSTRAINT "cashflow_events_planned_asset_id_fkey"
      FOREIGN KEY ("planned_asset_id") REFERENCES "assets"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashflow_events_privacy_owner_member_id_fkey') THEN
    ALTER TABLE "cashflow_events" ADD CONSTRAINT "cashflow_events_privacy_owner_member_id_fkey"
      FOREIGN KEY ("privacy_owner_member_id") REFERENCES "household_members"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 8. Rename every inherited index/constraint to the name Prisma expects.
--    Renaming a table does NOT rename these, and Prisma detects drift by name.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  obj RECORD;
BEGIN
  -- due_date is now expected_date, so that index needs the column rename too.
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'upcoming_payments_household_id_due_date_idx') THEN
    ALTER INDEX "upcoming_payments_household_id_due_date_idx"
      RENAME TO "cashflow_events_household_id_expected_date_idx";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'upcoming_payments_household_live_idx') THEN
    ALTER INDEX "upcoming_payments_household_live_idx"
      RENAME TO "cashflow_events_household_live_idx";
  END IF;

  FOR obj IN
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relkind IN ('i', 'I')
       AND c.relname LIKE 'upcoming_payments%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', obj.name,
                   replace(obj.name, 'upcoming_payments', 'cashflow_events'));
  END LOOP;

  FOR obj IN
    SELECT con.conname AS name
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'cashflow_events'
       AND con.conname LIKE 'upcoming_payments%'
  LOOP
    EXECUTE format('ALTER TABLE "cashflow_events" RENAME CONSTRAINT %I TO %I',
                   obj.name,
                   replace(obj.name, 'upcoming_payments', 'cashflow_events'));
  END LOOP;
END $$;

-- The two FK constraints whose COLUMN also changed name.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashflow_events_paid_by_fkey') THEN
    ALTER TABLE "cashflow_events"
      RENAME CONSTRAINT "cashflow_events_paid_by_fkey" TO "cashflow_events_last_completed_by_fkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashflow_events_paid_from_asset_id_fkey') THEN
    ALTER TABLE "cashflow_events"
      RENAME CONSTRAINT "cashflow_events_paid_from_asset_id_fkey"
      TO "cashflow_events_last_completed_asset_id_fkey";
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 9. money_events link rename — same migration so the FK never dangles.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'money_events' AND column_name = 'upcoming_payment_id'
  ) THEN
    ALTER TABLE "money_events" RENAME COLUMN "upcoming_payment_id" TO "cashflow_event_id";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'money_events_upcoming_payment_id_idx') THEN
    ALTER INDEX "money_events_upcoming_payment_id_idx"
      RENAME TO "money_events_cashflow_event_id_idx";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_events_upcoming_payment_id_fkey') THEN
    ALTER TABLE "money_events"
      RENAME CONSTRAINT "money_events_upcoming_payment_id_fkey"
      TO "money_events_cashflow_event_id_fkey";
  END IF;
END $$;

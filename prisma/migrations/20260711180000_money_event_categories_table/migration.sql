-- PR5b: MoneyEventCategory enum -> money_event_categories table.
--
-- A Postgres enum can't drop values and needs a migration per new category;
-- users may want custom categories. So `money_events.category` becomes a free
-- CODE (text) resolved against a categories table (seeded system rows +
-- per-household custom rows). Also fixes the `interest` code being silently
-- coerced to `other` (it wasn't in the old enum).

-- 1. Categories table.
CREATE TABLE IF NOT EXISTS "money_event_categories" (
  "id"           UUID PRIMARY KEY,
  "household_id" UUID REFERENCES "households"("id") ON DELETE CASCADE,
  "code"         TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "is_system"    BOOLEAN NOT NULL DEFAULT false,
  "sort_order"   INTEGER NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at"   TIMESTAMPTZ(6)
);

CREATE INDEX IF NOT EXISTS "money_event_categories_household_live_idx"
  ON "money_event_categories" ("household_id", "deleted_at");
-- Unique code per household; global rows (household_id IS NULL) are unique too
-- (a bare UNIQUE treats NULLs as distinct, so guard globals with a partial idx).
CREATE UNIQUE INDEX IF NOT EXISTS "money_event_categories_household_code_uniq"
  ON "money_event_categories" ("household_id", "code")
  WHERE "household_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "money_event_categories_global_code_uniq"
  ON "money_event_categories" ("code")
  WHERE "household_id" IS NULL;

-- 2. Seed system (global) categories. gen_random_uuid() needs pgcrypto; it is
-- available by default on Supabase. ON CONFLICT keeps this idempotent.
INSERT INTO "money_event_categories" ("id", "household_id", "code", "label", "is_system", "sort_order")
VALUES
  (gen_random_uuid(), NULL, 'housing',        'Nhà ở',            true, 10),
  (gen_random_uuid(), NULL, 'education',       'Giáo dục',         true, 20),
  (gen_random_uuid(), NULL, 'transport',       'Đi lại',           true, 30),
  (gen_random_uuid(), NULL, 'health',          'Sức khỏe',         true, 40),
  (gen_random_uuid(), NULL, 'family_support',  'Hỗ trợ gia đình',  true, 50),
  (gen_random_uuid(), NULL, 'insurance',       'Bảo hiểm',         true, 60),
  (gen_random_uuid(), NULL, 'saving',          'Tiết kiệm',        true, 70),
  (gen_random_uuid(), NULL, 'investment',      'Đầu tư',           true, 80),
  (gen_random_uuid(), NULL, 'debt',            'Nợ',               true, 90),
  (gen_random_uuid(), NULL, 'income',          'Thu nhập',         true, 100),
  (gen_random_uuid(), NULL, 'interest',        'Lãi',              true, 110),
  (gen_random_uuid(), NULL, 'repair',          'Sửa chữa',         true, 120),
  (gen_random_uuid(), NULL, 'household',       'Chi tiêu nhà',     true, 130),
  (gen_random_uuid(), NULL, 'children',        'Con cái',          true, 140),
  (gen_random_uuid(), NULL, 'travel',          'Du lịch',          true, 150),
  (gen_random_uuid(), NULL, 'other',           'Khác',             true, 999)
ON CONFLICT DO NOTHING;

-- 3. Convert money_events.category from enum to text, then drop the enum.
ALTER TABLE "money_events"
  ALTER COLUMN "category" DROP DEFAULT,
  ALTER COLUMN "category" TYPE TEXT USING "category"::text,
  ALTER COLUMN "category" SET DEFAULT 'other';

DROP TYPE IF EXISTS "MoneyEventCategory";

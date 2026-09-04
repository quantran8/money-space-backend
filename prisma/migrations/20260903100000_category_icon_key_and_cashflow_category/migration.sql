-- Two related changes, both about giving a money record a category you can SEE.
--
-- 1. `money_event_categories.icon_key` — a stable glyph key the frontend maps to
--    an icon component. Stored on the row rather than mapped from `code` on the
--    client, so a household's CUSTOM category can pick a glyph too; a code-based
--    map only ever covers the seeded set.
-- 2. `cashflow_events.category` — an upcoming item is classified the same way a
--    recorded one is. Completing one already creates a money event, and it used
--    to hardcode `category = 'other'` for every outgoing item, so the whole
--    upcoming side of the app landed in one bucket.
--
-- See memory/money-events.md (Category UI) and memory/cashflow-events.md.

-- 1. Icon key -----------------------------------------------------------------

-- Nullable, no default: NULL means "no glyph chosen", which the client renders
-- with its fallback. A default here would claim every custom category had
-- deliberately picked the fallback glyph.
ALTER TABLE "money_event_categories"
  ADD COLUMN IF NOT EXISTS "icon_key" TEXT;

-- Seed the 16 system categories. Keys are lucide icon names in kebab-case; the
-- client owns the key → component map and falls back on anything it does not
-- know, so adding a key here can never break a render.
UPDATE "money_event_categories" SET "icon_key" = v."icon_key"
FROM (VALUES
  ('housing',        'house'),
  ('education',      'graduation-cap'),
  ('transport',      'bus'),
  ('health',         'heart-pulse'),
  ('family_support', 'users'),
  ('insurance',      'shield-check'),
  ('saving',         'piggy-bank'),
  ('investment',     'trending-up'),
  ('debt',           'landmark'),
  ('income',         'arrow-down-left'),
  ('interest',       'percent'),
  ('repair',         'wrench'),
  ('household',      'shopping-basket'),
  ('children',       'baby'),
  ('travel',         'plane'),
  ('other',          'circle-dashed')
) AS v("code", "icon_key")
WHERE "money_event_categories"."code" = v."code"
  AND "money_event_categories"."household_id" IS NULL;

-- 2. Cashflow category --------------------------------------------------------

-- NOT NULL with the same default as `money_events.category`, so both tables
-- answer "which category" the same way and existing rows backfill to 'other'
-- rather than becoming a null every reader has to handle.
ALTER TABLE "cashflow_events"
  ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'other';

-- Upcoming items are filtered and grouped by category the way events are.
CREATE INDEX IF NOT EXISTS "cashflow_events_household_category_idx"
  ON "cashflow_events" ("household_id", "category")
  WHERE "deleted_at" IS NULL;

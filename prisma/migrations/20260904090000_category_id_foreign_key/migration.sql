-- `category` was a free TEXT code on money_events / cashflow_events, resolved
-- against money_event_categories at the app layer only. This makes it a real
-- foreign key.
--
-- Why it could not already be one: `code` is unique only per SCOPE — a partial
-- unique index per household plus another for the global rows (household_id IS
-- NULL) — so no single unique constraint covers it and nothing can reference
-- it. `id` is a global PK, so `category_id` can.
--
-- Resolution order when backfilling matches the app's own lookup
-- (`codeExists` / `findCategoryByCode`): the row's OWN household category
-- first, then the shared system row. Anything still unmatched (a code whose
-- category was hard-deleted, or data predating the categories table) falls back
-- to the system `other` row rather than becoming NULL — the column is NOT NULL
-- and an event always belongs to some category.
--
-- See memory/money-events.md (Category UI) and memory/cashflow-events.md.

-- 1. money_events ------------------------------------------------------------

ALTER TABLE "money_events" ADD COLUMN IF NOT EXISTS "category_id" UUID;

UPDATE "money_events" e
SET "category_id" = c."id"
FROM "money_event_categories" c
WHERE c."deleted_at" IS NULL
  AND c."code" = e."category"
  AND c."household_id" = e."household_id"
  AND e."category_id" IS NULL;

UPDATE "money_events" e
SET "category_id" = c."id"
FROM "money_event_categories" c
WHERE c."deleted_at" IS NULL
  AND c."code" = e."category"
  AND c."household_id" IS NULL
  AND e."category_id" IS NULL;

UPDATE "money_events" e
SET "category_id" = (
  SELECT c."id" FROM "money_event_categories" c
  WHERE c."household_id" IS NULL AND c."code" = 'other' AND c."deleted_at" IS NULL
  LIMIT 1
)
WHERE e."category_id" IS NULL;

ALTER TABLE "money_events" ALTER COLUMN "category_id" SET NOT NULL;

ALTER TABLE "money_events"
  ADD CONSTRAINT "money_events_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "money_event_categories"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX IF EXISTS "money_events_household_id_category_idx";
CREATE INDEX IF NOT EXISTS "money_events_household_id_category_id_idx"
  ON "money_events" ("household_id", "category_id");

ALTER TABLE "money_events" DROP COLUMN "category";

-- 2. cashflow_events ---------------------------------------------------------

ALTER TABLE "cashflow_events" ADD COLUMN IF NOT EXISTS "category_id" UUID;

UPDATE "cashflow_events" e
SET "category_id" = c."id"
FROM "money_event_categories" c
WHERE c."deleted_at" IS NULL
  AND c."code" = e."category"
  AND c."household_id" = e."household_id"
  AND e."category_id" IS NULL;

UPDATE "cashflow_events" e
SET "category_id" = c."id"
FROM "money_event_categories" c
WHERE c."deleted_at" IS NULL
  AND c."code" = e."category"
  AND c."household_id" IS NULL
  AND e."category_id" IS NULL;

UPDATE "cashflow_events" e
SET "category_id" = (
  SELECT c."id" FROM "money_event_categories" c
  WHERE c."household_id" IS NULL AND c."code" = 'other' AND c."deleted_at" IS NULL
  LIMIT 1
)
WHERE e."category_id" IS NULL;

ALTER TABLE "cashflow_events" ALTER COLUMN "category_id" SET NOT NULL;

ALTER TABLE "cashflow_events"
  ADD CONSTRAINT "cashflow_events_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "money_event_categories"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX IF EXISTS "cashflow_events_household_category_idx";
CREATE INDEX IF NOT EXISTS "cashflow_events_household_id_category_id_idx"
  ON "cashflow_events" ("household_id", "category_id");

ALTER TABLE "cashflow_events" DROP COLUMN "category";

-- 3. households.config: defaultEventCategoryCode -> defaultEventCategoryId ----
--
-- Same problem, same fix: the household's default-category pointer was a code
-- string in the config jsonb. Rewrite it to the resolved category id, dropping
-- the pointer entirely when the code no longer resolves (rather than pointing
-- the default at `other`, which would silently CHANGE the household's choice).

UPDATE "households" h
SET "config" = (h."config" - 'defaultEventCategoryCode')
  || jsonb_build_object(
       'defaultEventCategoryId',
       (
         SELECT c."id"::text
         FROM "money_event_categories" c
         WHERE c."deleted_at" IS NULL
           AND c."code" = h."config" ->> 'defaultEventCategoryCode'
           AND (c."household_id" = h."id" OR c."household_id" IS NULL)
         -- The household's OWN row wins over the shared system row, matching
         -- `findCategoryByCode`. Without the ordering a household that shadowed
         -- a system code would resolve to whichever row the planner reached
         -- first.
         ORDER BY c."household_id" NULLS LAST
         LIMIT 1
       )
     )
WHERE h."config" ? 'defaultEventCategoryCode'
  AND EXISTS (
    SELECT 1
    FROM "money_event_categories" c
    WHERE c."deleted_at" IS NULL
      AND c."code" = h."config" ->> 'defaultEventCategoryCode'
      AND (c."household_id" = h."id" OR c."household_id" IS NULL)
  );

UPDATE "households"
SET "config" = ("config" - 'defaultEventCategoryCode')
WHERE "config" ? 'defaultEventCategoryCode';

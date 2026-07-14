-- Per-household config bag.
--
-- A jsonb column on households for household-scoped settings that don't warrant
-- their own column. First use: `defaultEventCategoryCode` — the money-event
-- category auto-selected in the create form. A household can point it at either a
-- system category code (shared, household_id IS NULL) or one of its own custom
-- category codes, which is why the default lives here (on the household) rather
-- than as a boolean on the shared money_event_categories rows.
ALTER TABLE "households"
  ADD COLUMN "config" jsonb NOT NULL DEFAULT '{}'::jsonb;

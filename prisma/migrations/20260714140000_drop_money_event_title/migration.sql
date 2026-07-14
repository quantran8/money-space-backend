-- Drop the `title` column from money_events.
--
-- `title` was a free-text label the create/edit form required and internal
-- flows (debts, saving interest, revaluations) auto-generated (e.g.
-- "Vay: <debt>", "Lãi tiết kiệm: <asset>"). It has been removed from the domain:
--   * the user-facing form no longer collects a title;
--   * `category` (already present, required at the app layer) is now the
--     primary classification/label for an event;
--   * the descriptive label that internal flows used to put in `title` is now
--     folded into `description` (the event note).
--
-- Preserve existing labels: for any row whose `description` is empty/null but
-- whose `title` is set, copy `title` into `description` before dropping the
-- column, so historical events keep their human-readable label in the note.
UPDATE "money_events"
SET "description" = "title"
WHERE ("description" IS NULL OR btrim("description") = '')
  AND "title" IS NOT NULL
  AND btrim("title") <> '';

-- Now remove the column.
ALTER TABLE "money_events" DROP COLUMN "title";

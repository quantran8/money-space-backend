-- The disc a category renders as gets a household-chosen fill, with the glyph
-- itself defaulting to white so it reads against any colour the household
-- picks. See memory/money-events.md (Category UI).

ALTER TABLE "money_event_categories"
  ADD COLUMN IF NOT EXISTS "icon_color" TEXT;

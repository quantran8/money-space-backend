-- System category for eating and drinking out. Idempotent: the row may already
-- exist where it was inserted by hand. See memory/money-events.md (Category).
INSERT INTO "money_event_categories" ("id", "household_id", "code", "label", "icon_key", "is_system", "sort_order")
SELECT gen_random_uuid(), NULL, 'food_drink', 'Ăn uống', 'utensils', true, 35
WHERE NOT EXISTS (
  SELECT 1 FROM "money_event_categories"
  WHERE "household_id" IS NULL AND "code" = 'food_drink'
);

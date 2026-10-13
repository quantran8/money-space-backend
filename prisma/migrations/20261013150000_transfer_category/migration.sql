-- System category for moves between the household's own wallets.
-- See memory/money-events.md (Category).
INSERT INTO "money_event_categories" ("id", "household_id", "code", "label", "icon_key", "is_system", "sort_order")
SELECT gen_random_uuid(), NULL, 'transfer', 'Chuyển tiền', 'arrow-left-right', true, 990
WHERE NOT EXISTS (
  SELECT 1 FROM "money_event_categories"
  WHERE "household_id" IS NULL AND "code" = 'transfer'
);

-- Bank-sync used to file paired transfers under 'other'.
UPDATE "money_events" e
SET "category_id" = t."id"
FROM "money_event_categories" t, "money_event_categories" o
WHERE e."event_type" = 'transfer'
  AND e."category_id" = o."id"
  AND o."household_id" IS NULL AND o."code" = 'other'
  AND t."household_id" IS NULL AND t."code" = 'transfer';

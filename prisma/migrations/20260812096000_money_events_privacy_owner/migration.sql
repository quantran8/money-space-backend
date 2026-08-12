-- v3.1 §30: money events carry their own privacy owner, distinct from the
-- person who recorded them.

ALTER TABLE "money_events"
  ADD COLUMN IF NOT EXISTS "privacy_owner_member_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_events_privacy_owner_member_id_fkey') THEN
    ALTER TABLE "money_events"
      ADD CONSTRAINT "money_events_privacy_owner_member_id_fkey"
      FOREIGN KEY ("privacy_owner_member_id") REFERENCES "household_members"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Same one-time legacy fallback as assets: resolve existing private events'
-- privacy owner from their creator's membership.
UPDATE "money_events" e
   SET "privacy_owner_member_id" = m."id"
  FROM "household_members" m
 WHERE e."visibility_level" = 'private'
   AND e."privacy_owner_member_id" IS NULL
   AND m."household_id" = e."household_id"
   AND m."user_id" = e."created_by"
   AND m."deleted_at" IS NULL;

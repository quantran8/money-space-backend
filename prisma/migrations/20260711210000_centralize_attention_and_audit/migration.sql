-- PR7: centralize attention, drop derived/unused flags, relax audit FKs.
--
-- * money_events.is_large_event / is_attention_needed  -> DROP (never read;
--     attention lives in the attention_items table)
-- * upcoming_payments.is_attention_needed              -> DROP (= attention_level
--     === 'important', a pure derived mirror; attention_level itself stays)
-- * attention_items.deleted_at                         -> DROP (status =
--     'dismissed' already means gone; two delete signals conflict)
-- * attention_items.created_by                         -> nullable + SET NULL
-- * audit_logs.actor_id                                -> nullable + SET NULL
--     (system/worker flows have no request user)

-- Derived / unused flags.
ALTER TABLE "money_events"      DROP COLUMN IF EXISTS "is_large_event";
ALTER TABLE "money_events"      DROP COLUMN IF EXISTS "is_attention_needed";
ALTER TABLE "upcoming_payments" DROP COLUMN IF EXISTS "is_attention_needed";

-- attention_items: drop redundant soft-delete, relax creator FK.
ALTER TABLE "attention_items" DROP COLUMN IF EXISTS "deleted_at";
ALTER TABLE "attention_items" ALTER COLUMN "created_by" DROP NOT NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attention_items_created_by_fkey') THEN
    ALTER TABLE "attention_items" DROP CONSTRAINT "attention_items_created_by_fkey";
  END IF;
  ALTER TABLE "attention_items"
    ADD CONSTRAINT "attention_items_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "profiles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
END $$;

-- audit_logs: nullable actor (NULL = system) + SET NULL on profile delete.
ALTER TABLE "audit_logs" ALTER COLUMN "actor_id" DROP NOT NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_actor_id_fkey') THEN
    ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_id_fkey";
  END IF;
  ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "profiles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
END $$;

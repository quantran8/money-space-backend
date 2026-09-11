-- RevenueCat in-app purchases.
--
-- Apple and Google forbid steering out of the app to pay, so the mobile client
-- buys through the store and RevenueCat tells us about it. The household
-- entitlement is still granted by `grantOrExtend` — this only adds the records
-- that let a store purchase reach it.

-- One value for both stores: RevenueCat is the system of record either way.
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'revenuecat';

DO $$ BEGIN
  CREATE TYPE "PurchaseStore" AS ENUM ('app_store', 'play_store');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- An IAP is never handed to PayOS, so it has no integer order reference.
ALTER TABLE "payment_orders" ALTER COLUMN "order_code" DROP NOT NULL;

-- A store-initiated renewal has no actor: Apple charging a card a year later
-- is not a person acting.
ALTER TABLE "payment_orders" DROP CONSTRAINT IF EXISTS "payment_orders_created_by_fkey";
ALTER TABLE "payment_orders" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "payment_orders"
  ADD CONSTRAINT "payment_orders_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_orders"
  ADD COLUMN IF NOT EXISTS "store" "PurchaseStore",
  ADD COLUMN IF NOT EXISTS "provider_user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "product_id" TEXT,
  ADD COLUMN IF NOT EXISTS "store_expires_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "payment_orders_provider_user_id_idx"
  ON "payment_orders"("provider_user_id");

-- The mapping that makes a renewal settleable: a webhook arriving a year later
-- carries only `app_user_id`, and without this the money could not be attached
-- to a household.
CREATE TABLE IF NOT EXISTS "revenuecat_subscribers" (
  "id" UUID NOT NULL,
  "provider_user_id" TEXT NOT NULL,
  "profile_id" UUID,
  "household_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "revenuecat_subscribers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "revenuecat_subscribers_provider_user_id_key"
  ON "revenuecat_subscribers"("provider_user_id");
CREATE INDEX IF NOT EXISTS "revenuecat_subscribers_household_id_idx"
  ON "revenuecat_subscribers"("household_id");

ALTER TABLE "revenuecat_subscribers"
  ADD CONSTRAINT "revenuecat_subscribers_household_id_fkey"
  FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "revenuecat_subscribers"
  ADD CONSTRAINT "revenuecat_subscribers_profile_id_fkey"
  FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

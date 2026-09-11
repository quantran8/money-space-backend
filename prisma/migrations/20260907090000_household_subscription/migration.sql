-- The household's plan, for the freemium model. One row per household.
--
-- Deliberately NOT backfilled for existing households: a missing row and
-- `tier = 'free'` mean the same thing to `EntitlementService`, so the row is
-- created on the first grant (redeem, payment, or trial) and nothing has to
-- migrate. This is also why every column that describes a paid plan is
-- nullable.
--
-- Lifetime is `tier = 'premium'` with `current_period_end IS NULL`, so there is
-- no separate flag: the expiry sweep filters `current_period_end < now()` and
-- skips those rows with no special case. `tier` is what distinguishes a
-- lifetime row from a never-purchased one.
--
-- See memory/subscription.md.

CREATE TYPE "SubscriptionTier" AS ENUM ('free', 'premium');
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'expired');
CREATE TYPE "EntitlementSource" AS ENUM ('redeem_code', 'payment', 'manual_grant', 'trial');

CREATE TABLE "household_subscriptions" (
    "id"                 UUID                 NOT NULL,
    "household_id"       UUID                 NOT NULL,
    "tier"               "SubscriptionTier"   NOT NULL DEFAULT 'free',
    "status"             "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "current_period_end" TIMESTAMPTZ(6),
    "source"             "EntitlementSource",
    "auto_renew"         BOOLEAN              NOT NULL DEFAULT false,
    "trial_started_at"   TIMESTAMPTZ(6),
    "trial_ends_at"      TIMESTAMPTZ(6),
    "note"               TEXT                 NOT NULL DEFAULT '',
    "created_at"         TIMESTAMPTZ(6)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ(6)       NOT NULL,

    CONSTRAINT "household_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "household_subscriptions_household_id_key"
    ON "household_subscriptions"("household_id");

-- Covers the expiry sweep: WHERE tier = 'premium' AND current_period_end < now().
CREATE INDEX "household_subscriptions_tier_current_period_end_idx"
    ON "household_subscriptions"("tier", "current_period_end");

-- CASCADE: a deleted household has no plan to keep, and the row carries no
-- financial record of its own — payments and redemptions are their own tables.
ALTER TABLE "household_subscriptions"
    ADD CONSTRAINT "household_subscriptions_household_id_fkey"
    FOREIGN KEY ("household_id") REFERENCES "households"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

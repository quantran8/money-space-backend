-- Activation codes, and the receipt for each redemption.
--
-- `code` is stored in PLAINTEXT deliberately: support has to be able to read a
-- code back when a customer loses the message, which hashing makes impossible.
-- It is not a password — one leaked code is worth 39.000đ, `max_redemptions`
-- caps the loss, and brute force is answered by 35 bits of entropy plus rate
-- limiting. Hashing would slow an attacker working over HTTP by nothing.
--
-- The two constraints below are the concurrency design, not bookkeeping:
--
--   * `redeem_code_redemptions_redeem_code_id_household_id_key` makes "one
--     household, one code, once" a database rule, so two simultaneous requests
--     cannot both win.
--   * `redemption_count < max_redemptions` lives in the WHERE clause of the
--     claim UPDATE (see `claimRedeemCodeSlot`), which is what makes claiming a
--     slot atomic without an advisory lock — that helper is explicitly
--     "advisory only, not exactly-once", which is fine for a cron and not fine
--     for money.
--
-- See memory/subscription.md.

CREATE TYPE "RedeemCodeStatus" AS ENUM ('active', 'disabled', 'exhausted');
CREATE TYPE "RedeemGrantType" AS ENUM ('duration_days', 'until_date', 'lifetime');

CREATE TABLE "redeem_codes" (
    "id"                  UUID               NOT NULL,
    "code"                VARCHAR(32)        NOT NULL,
    "campaign"            VARCHAR(64)        NOT NULL,
    "status"              "RedeemCodeStatus" NOT NULL DEFAULT 'active',
    "grant_tier"          "SubscriptionTier" NOT NULL DEFAULT 'premium',
    "grant_type"          "RedeemGrantType"  NOT NULL,
    "grant_duration_days" INTEGER,
    "grant_until"         TIMESTAMPTZ(6),
    "max_redemptions"     INTEGER            NOT NULL DEFAULT 1,
    "redemption_count"    INTEGER            NOT NULL DEFAULT 0,
    "expires_at"          TIMESTAMPTZ(6),
    "note"                TEXT               NOT NULL DEFAULT '',
    "created_by"          UUID,
    "created_at"          TIMESTAMPTZ(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(6)     NOT NULL,
    "deleted_at"          TIMESTAMPTZ(6),

    CONSTRAINT "redeem_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "redeem_codes_code_key" ON "redeem_codes"("code");
CREATE INDEX "redeem_codes_campaign_status_idx" ON "redeem_codes"("campaign", "status");
CREATE INDEX "redeem_codes_status_expires_at_idx" ON "redeem_codes"("status", "expires_at");

CREATE TABLE "redeem_code_redemptions" (
    "id"                UUID           NOT NULL,
    "redeem_code_id"    UUID           NOT NULL,
    "household_id"      UUID           NOT NULL,
    "redeemed_by"       UUID           NOT NULL,
    "granted_days"      INTEGER,
    "period_end_before" TIMESTAMPTZ(6),
    "period_end_after"  TIMESTAMPTZ(6),
    "redeemed_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redeem_code_redemptions_pkey" PRIMARY KEY ("id")
);

-- The "one household, one code, once" invariant. Also the second race barrier.
CREATE UNIQUE INDEX "redeem_code_redemptions_redeem_code_id_household_id_key"
    ON "redeem_code_redemptions"("redeem_code_id", "household_id");
CREATE INDEX "redeem_code_redemptions_household_id_redeemed_at_idx"
    ON "redeem_code_redemptions"("household_id", "redeemed_at");

ALTER TABLE "redeem_code_redemptions"
    ADD CONSTRAINT "redeem_code_redemptions_redeem_code_id_fkey"
    FOREIGN KEY ("redeem_code_id") REFERENCES "redeem_codes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "redeem_code_redemptions"
    ADD CONSTRAINT "redeem_code_redemptions_household_id_fkey"
    FOREIGN KEY ("household_id") REFERENCES "households"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, unlike the two above: a profile is identity, and the receipt has to
-- keep saying who redeemed it.
ALTER TABLE "redeem_code_redemptions"
    ADD CONSTRAINT "redeem_code_redemptions_redeemed_by_fkey"
    FOREIGN KEY ("redeemed_by") REFERENCES "profiles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

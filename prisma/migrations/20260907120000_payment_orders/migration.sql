-- PayOS checkout: one row per checkout, moved through its states.
--
-- Chosen over Casso (reconciles transfers, has no checkout) and VNPay (business
-- licence, 2-4 weeks of approval, 1.1-2.2% per transaction — the whole margin
-- at 39.000d). PayOS is 0d per transaction and hosts the QR page itself.

CREATE TYPE "PaymentProvider" AS ENUM ('payos');

CREATE TYPE "PaymentOrderStatus" AS ENUM ('pending', 'paid', 'cancelled', 'expired');

CREATE TABLE "payment_orders" (
  "id"                UUID PRIMARY KEY,
  "household_id"      UUID NOT NULL,
  "provider"          "PaymentProvider" NOT NULL DEFAULT 'payos',
  "status"            "PaymentOrderStatus" NOT NULL DEFAULT 'pending',
  -- PayOS requires an INTEGER order reference, unique per merchant; a string
  -- ref is not accepted. BIGINT because the generated value carries a
  -- timestamp.
  "order_code"        BIGINT NOT NULL,
  -- A plain string, not an enum: an order is a historical record, and retiring
  -- a plan must not make an old receipt unreadable.
  "plan_code"         TEXT NOT NULL,
  -- Integer dong. VND has no minor unit, and a numeric here would invite
  -- fractions no bank transfer can settle. All three are kept so an order
  -- survives both a price change and the expiry of the campaign it was bought
  -- under.
  "amount_original"   INTEGER NOT NULL,
  "discount_amount"   INTEGER NOT NULL DEFAULT 0,
  "amount"            INTEGER NOT NULL,
  -- NULL = lifetime, matching PLAN_CATALOG. Frozen at creation so changing a
  -- plan's duration cannot retroactively alter what an unpaid order is worth.
  "duration_days"     INTEGER,
  -- The primary idempotency barrier: a webhook delivered twice violates this
  -- on the second write, which is caught and swallowed.
  "provider_txn_id"   TEXT,
  "checkout_url"      TEXT,
  "provider_order_id" TEXT,
  -- The verified webhook body, verbatim. Kept for what a status column cannot
  -- answer — chiefly an underpayment, where a human has to see what arrived.
  "raw_payload"       JSONB,
  "created_by"        UUID NOT NULL,
  "paid_at"           TIMESTAMPTZ(6),
  "expires_at"        TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

ALTER TABLE "payment_orders"
  ADD CONSTRAINT "payment_orders_household_id_fkey"
  FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_orders"
  ADD CONSTRAINT "payment_orders_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Both uniques are race barriers, not conveniences: they are what make a
-- duplicate webhook delivery and a same-second order collision fail loudly
-- instead of silently granting twice.
CREATE UNIQUE INDEX "payment_orders_order_code_key"
  ON "payment_orders" ("order_code");

CREATE UNIQUE INDEX "payment_orders_provider_txn_id_key"
  ON "payment_orders" ("provider_txn_id");

-- The subscription page reads a household's orders newest first.
CREATE INDEX "payment_orders_household_id_created_at_idx"
  ON "payment_orders" ("household_id", "created_at" DESC);

-- The sweep that expires stale pending orders.
CREATE INDEX "payment_orders_status_expires_at_idx"
  ON "payment_orders" ("status", "expires_at");

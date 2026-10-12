-- Bank notification sync. See memory/bank-sync.md.

CREATE TYPE "MoneyEventOrigin" AS ENUM ('manual', 'bank_notification');
CREATE TYPE "BankCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "BankSourceType" AS ENUM ('BANK_ACCOUNT', 'EWALLET');
CREATE TYPE "BankSourceStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "BankPostingMode" AS ENUM ('REVIEW', 'AUTO');
CREATE TYPE "BankEventStatus" AS ENUM (
  'RECEIVED', 'PARSE_FAILED', 'UNMAPPED', 'REVIEW', 'PROCESSED', 'DUPLICATE', 'FAILED', 'IGNORED'
);
CREATE TYPE "BankTimeSource" AS ENUM ('CONTENT', 'NOTIFICATION', 'RECEIVED');

CREATE TABLE "bank_ingest_credentials" (
  "id"           UUID PRIMARY KEY,
  "user_id"      UUID NOT NULL REFERENCES "profiles"("id"),
  "household_id" UUID NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "device_label" TEXT NOT NULL,
  "token_hash"   TEXT NOT NULL UNIQUE,
  "token_prefix" TEXT,
  "status"       "BankCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  "expires_at"   TIMESTAMPTZ(6),
  "last_used_at" TIMESTAMPTZ(6),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "revoked_at"   TIMESTAMPTZ(6)
);
CREATE INDEX "bank_ingest_credentials_household_user_idx"
  ON "bank_ingest_credentials" ("household_id", "user_id");

CREATE TABLE "bank_external_sources" (
  "id"               UUID PRIMARY KEY,
  "household_id"     UUID NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "created_by"       UUID NOT NULL REFERENCES "profiles"("id"),
  "source_type"      "BankSourceType" NOT NULL DEFAULT 'BANK_ACCOUNT',
  "provider_code"    TEXT NOT NULL,
  "identifier_hmac"  TEXT NOT NULL,
  "identifier_last4" TEXT,
  "display_label"    TEXT,
  "status"           "BankSourceStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "bank_external_sources_identity_uniq"
  ON "bank_external_sources" ("household_id", "provider_code", "identifier_hmac");

CREATE TABLE "bank_source_links" (
  "id"                 UUID PRIMARY KEY,
  "household_id"       UUID NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "external_source_id" UUID NOT NULL REFERENCES "bank_external_sources"("id") ON DELETE CASCADE,
  "asset_id"           UUID NOT NULL REFERENCES "assets"("id"),
  "posting_mode"       "BankPostingMode" NOT NULL DEFAULT 'REVIEW',
  "valid_from"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "valid_to"           TIMESTAMPTZ(6),
  "created_by"         UUID NOT NULL REFERENCES "profiles"("id"),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "bank_source_links_valid_range" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);
CREATE UNIQUE INDEX "bank_source_links_one_open_uniq"
  ON "bank_source_links" ("external_source_id") WHERE "valid_to" IS NULL;
CREATE INDEX "bank_source_links_source_range_idx"
  ON "bank_source_links" ("external_source_id", "valid_from");

CREATE TABLE "bank_notification_events" (
  "id"                     UUID PRIMARY KEY,
  "household_id"           UUID NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "user_id"                UUID NOT NULL REFERENCES "profiles"("id"),
  "ingest_credential_id"   UUID NOT NULL REFERENCES "bank_ingest_credentials"("id"),
  "client_event_id"        UUID NOT NULL,
  "provider_code"          TEXT,
  "app_name"               TEXT NOT NULL,
  "title_redacted"         TEXT,
  "raw_payload_ciphertext" BYTEA,
  "raw_expires_at"         TIMESTAMPTZ(6),
  "payload_fingerprint"    TEXT,
  "identifier_hmac"        TEXT,
  "identifier_last4"       TEXT,
  "source_id"              UUID REFERENCES "bank_external_sources"("id") ON DELETE SET NULL,
  "matched_asset_id"       UUID REFERENCES "assets"("id"),
  "amount_minor"           BIGINT,
  "direction"              TEXT CHECK ("direction" IN ('IN', 'OUT')),
  "reported_balance_minor" BIGINT,
  "transaction_at"         TIMESTAMPTZ(6),
  "notification_at"        TIMESTAMPTZ(6),
  "time_source"            "BankTimeSource",
  "external_reference"     TEXT,
  "parser_version"         TEXT,
  "status"                 "BankEventStatus" NOT NULL DEFAULT 'RECEIVED',
  "status_reason"          TEXT,
  "received_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "processed_at"           TIMESTAMPTZ(6),
  "processed_by"           UUID REFERENCES "profiles"("id"),
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "bank_notification_events_client_event_uniq"
  ON "bank_notification_events" ("ingest_credential_id", "client_event_id");
CREATE INDEX "bank_notification_events_inbox_idx"
  ON "bank_notification_events" ("household_id", "status", "received_at" DESC);
CREATE INDEX "bank_notification_events_source_time_idx"
  ON "bank_notification_events" ("household_id", "source_id", "transaction_at");
CREATE INDEX "bank_notification_events_identifier_idx"
  ON "bank_notification_events" ("household_id", "identifier_hmac", "status");
CREATE INDEX "bank_notification_events_raw_expiry_idx"
  ON "bank_notification_events" ("raw_expires_at") WHERE "raw_payload_ciphertext" IS NOT NULL;

ALTER TABLE "money_events"
  ADD COLUMN "origin" "MoneyEventOrigin" NOT NULL DEFAULT 'manual',
  ADD COLUMN "notification_event_id" UUID
    REFERENCES "bank_notification_events"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "money_events_notification_event_id_key"
  ON "money_events" ("notification_event_id");

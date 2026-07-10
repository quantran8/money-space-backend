-- CreateEnum
CREATE TYPE "HouseholdRole" AS ENUM ('owner', 'partner', 'viewer');

-- CreateEnum
CREATE TYPE "PermissionLevel" AS ENUM ('view_summary', 'view_grouped', 'view_detail', 'edit_content', 'admin');

-- CreateEnum
CREATE TYPE "UpdateFrequency" AS ENUM ('weekly', 'monthly', 'manual');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('pending', 'accepted', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('good', 'attention', 'tight', 'insufficient_data');

-- CreateEnum
CREATE TYPE "SnapshotSourceMode" AS ENUM ('manual', 'calculated', 'mixed');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('cash', 'bank_account', 'saving_deposit', 'bond', 'gold', 'stock', 'fund', 'crypto', 'foreign_currency', 'real_estate', 'insurance', 'loan_receivable', 'certificate_of_deposit', 'investment', 'other');

-- CreateEnum
CREATE TYPE "AssetValuationMode" AS ENUM ('manual', 'market_priced', 'formula_calculated');

-- CreateEnum
CREATE TYPE "AssetLiquidity" AS ENUM ('usable_now', 'not_immediately_usable', 'long_term');

-- CreateEnum
CREATE TYPE "VisibilityLevel" AS ENUM ('summary_only', 'grouped', 'detail', 'private');

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('gold', 'crypto', 'stock', 'fund', 'foreign_currency');

-- CreateEnum
CREATE TYPE "AssetCalculationType" AS ENUM ('saving_deposit', 'bond', 'loan_receivable', 'certificate_of_deposit', 'custom_interest');

-- CreateEnum
CREATE TYPE "InterestRateType" AS ENUM ('fixed', 'floating');

-- CreateEnum
CREATE TYPE "CompoundingFrequency" AS ENUM ('none', 'daily', 'monthly', 'quarterly', 'yearly', 'at_maturity');

-- CreateEnum
CREATE TYPE "PayoutFrequency" AS ENUM ('at_maturity', 'monthly', 'quarterly', 'yearly');

-- CreateEnum
CREATE TYPE "AssetCalculationStatus" AS ENUM ('active', 'matured', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "AssetValuationMethod" AS ENUM ('manual', 'market_price_api', 'formula_calculated', 'statement', 'appraised', 'other');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "PaymentFrequency" AS ENUM ('once', 'weekly', 'monthly', 'quarterly', 'yearly');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('unpaid', 'paid', 'pending_confirmation', 'postponed', 'overdue');

-- CreateEnum
CREATE TYPE "AttentionLevel" AS ENUM ('normal', 'important', 'urgent');

-- CreateEnum
CREATE TYPE "DebtType" AS ENUM ('family_loan', 'friend_loan', 'bank_loan', 'consumer_finance', 'mortgage', 'credit_card', 'installment', 'other');

-- CreateEnum
CREATE TYPE "LenderType" AS ENUM ('family', 'friend', 'bank', 'credit_institution', 'company', 'other');

-- CreateEnum
CREATE TYPE "DebtStatus" AS ENUM ('active', 'paid_off', 'paused', 'overdue', 'cancelled');

-- CreateEnum
CREATE TYPE "DebtRepaymentType" AS ENUM ('flexible', 'fixed_schedule', 'installment', 'interest_only', 'minimum_payment', 'bullet_payment');

-- CreateEnum
CREATE TYPE "DebtPrincipalPaymentType" AS ENUM ('flexible', 'equal_principal', 'equal_payment', 'custom');

-- CreateEnum
CREATE TYPE "DebtInterestType" AS ENUM ('none', 'fixed', 'floating', 'staged');

-- CreateEnum
CREATE TYPE "DebtInterestCalculation" AS ENUM ('simple_interest', 'reducing_balance', 'flat_rate', 'custom');

-- CreateEnum
CREATE TYPE "DebtInterestRateType" AS ENUM ('fixed', 'floating', 'promotional', 'adjusted');

-- CreateEnum
CREATE TYPE "MoneyEventType" AS ENUM ('expense', 'income', 'transfer', 'asset_purchase', 'asset_sale', 'asset_update', 'payment_paid', 'goal_contribution', 'debt_update', 'adjustment', 'other');

-- CreateEnum
CREATE TYPE "MoneyEventCategory" AS ENUM ('housing', 'education', 'transport', 'health', 'family_support', 'insurance', 'saving', 'investment', 'debt', 'income', 'repair', 'household', 'children', 'travel', 'other');

-- CreateEnum
CREATE TYPE "MoneyDirection" AS ENUM ('inflow', 'outflow', 'neutral');

-- CreateEnum
CREATE TYPE "MoneyEventStatus" AS ENUM ('recorded', 'pending_confirmation', 'cancelled');

-- CreateEnum
CREATE TYPE "GoalCategory" AS ENUM ('emergency_fund', 'home', 'home_repair', 'children', 'travel', 'debt_repayment', 'investment', 'education', 'other');

-- CreateEnum
CREATE TYPE "GoalPriority" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('active', 'paused', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "RelatedObjectType" AS ENUM ('asset', 'upcoming_payment', 'financial_goal', 'snapshot', 'money_event', 'debt');

-- CreateEnum
CREATE TYPE "AttentionItemStatus" AS ENUM ('open', 'seen', 'resolved', 'dismissed');

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "full_name" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "households" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "update_frequency" "UpdateFrequency" NOT NULL DEFAULT 'weekly',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "households_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "household_members" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "HouseholdRole" NOT NULL DEFAULT 'partner',
    "permission_level" "PermissionLevel" NOT NULL DEFAULT 'view_detail',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invited_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "household_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "household_invites" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "invited_by" UUID NOT NULL,
    "invitee_email" TEXT,
    "invitee_phone" TEXT,
    "token" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'pending',
    "default_role" "HouseholdRole" NOT NULL DEFAULT 'partner',
    "default_permission_level" "PermissionLevel" NOT NULL DEFAULT 'view_detail',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_by" UUID,
    "accepted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "household_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshots" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_liquid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_savings" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_long_term_assets" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_debt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "upcoming_due_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "attention_count" INTEGER NOT NULL DEFAULT 0,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'insufficient_data',
    "source_mode" "SnapshotSourceMode" NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "valuation_mode" "AssetValuationMode" NOT NULL DEFAULT 'manual',
    "current_value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "value_updated_at" TIMESTAMPTZ(6),
    "holder_member_id" UUID,
    "liquidity" "AssetLiquidity" NOT NULL DEFAULT 'usable_now',
    "purpose" TEXT,
    "visibility_level" "VisibilityLevel" NOT NULL DEFAULT 'detail',
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_market_positions" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "symbol" TEXT,
    "market" TEXT,
    "asset_class" "AssetClass" NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "unit" TEXT,
    "quote_currency" TEXT NOT NULL,
    "price_source" TEXT,
    "price_source_symbol" TEXT,
    "last_price" DECIMAL(20,8),
    "last_price_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "asset_market_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_prices" (
    "id" UUID NOT NULL,
    "asset_class" "AssetClass" NOT NULL,
    "symbol" TEXT NOT NULL,
    "market" TEXT,
    "quote_currency" TEXT NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,
    "price_time" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT NOT NULL,
    "source_payload_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" UUID NOT NULL,
    "base_currency" TEXT NOT NULL,
    "quote_currency" TEXT NOT NULL,
    "rate" DECIMAL(20,8) NOT NULL,
    "rate_time" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_calculation_terms" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "calculation_type" "AssetCalculationType" NOT NULL,
    "principal_amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "start_date" DATE NOT NULL,
    "maturity_date" DATE,
    "interest_rate" DECIMAL(8,4),
    "interest_rate_type" "InterestRateType",
    "compounding_frequency" "CompoundingFrequency",
    "payout_frequency" "PayoutFrequency",
    "coupon_rate" DECIMAL(8,4),
    "coupon_frequency" "PayoutFrequency",
    "expected_return_rate" DECIMAL(8,4),
    "status" "AssetCalculationStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "asset_calculation_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_valuations" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "valuation_date" DATE NOT NULL,
    "valuation_method" "AssetValuationMethod" NOT NULL,
    "source" TEXT,
    "confidence_level" "ConfidenceLevel",
    "market_price_id" UUID,
    "fx_rate_id" UUID,
    "calculation_term_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "asset_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshot_asset_values" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "asset_name" TEXT NOT NULL,
    "asset_type" "AssetType" NOT NULL,
    "liquidity" "AssetLiquidity" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "valuation_id" UUID,
    "valuation_method" "AssetValuationMethod",
    "valuation_date" DATE,
    "visibility_level" "VisibilityLevel" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snapshot_asset_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debts" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "debt_type" "DebtType" NOT NULL,
    "lender_type" "LenderType" NOT NULL,
    "lender_name" TEXT,
    "original_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "outstanding_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "borrowed_at" DATE,
    "expected_final_due_date" DATE,
    "status" "DebtStatus" NOT NULL DEFAULT 'active',
    "owner_member_id" UUID,
    "received_to_asset_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "debts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debt_terms" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "debt_id" UUID NOT NULL,
    "repayment_type" "DebtRepaymentType" NOT NULL,
    "principal_payment_type" "DebtPrincipalPaymentType",
    "payment_frequency" TEXT,
    "fixed_payment_amount" DECIMAL(14,2),
    "minimum_payment_amount" DECIMAL(14,2),
    "start_date" DATE,
    "end_date" DATE,
    "has_interest" BOOLEAN NOT NULL DEFAULT false,
    "interest_type" "DebtInterestType" NOT NULL DEFAULT 'none',
    "interest_calculation" "DebtInterestCalculation",
    "grace_period_months" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "debt_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debt_interest_periods" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "debt_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "interest_rate" DECIMAL(8,4) NOT NULL,
    "rate_type" "DebtInterestRateType" NOT NULL DEFAULT 'fixed',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "debt_interest_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upcoming_payments" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "due_date" DATE NOT NULL,
    "frequency" "PaymentFrequency" NOT NULL DEFAULT 'once',
    "auto_create_next" BOOLEAN NOT NULL DEFAULT false,
    "owner_member_id" UUID,
    "debt_id" UUID,
    "status" "PaymentStatus" NOT NULL DEFAULT 'unpaid',
    "attention_level" "AttentionLevel" NOT NULL DEFAULT 'normal',
    "is_attention_needed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "paid_by" UUID,
    "paid_amount" DECIMAL(14,2),
    "paid_from_asset_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "upcoming_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_goals" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "GoalCategory" NOT NULL DEFAULT 'other',
    "target_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "current_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deadline" DATE,
    "priority" "GoalPriority" NOT NULL DEFAULT 'medium',
    "status" "GoalStatus" NOT NULL DEFAULT 'active',
    "linked_asset_id" UUID,
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "financial_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "money_events" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "event_type" "MoneyEventType" NOT NULL,
    "category" "MoneyEventCategory" NOT NULL DEFAULT 'other',
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "event_date" DATE NOT NULL,
    "direction" "MoneyDirection" NOT NULL,
    "from_asset_id" UUID,
    "to_asset_id" UUID,
    "upcoming_payment_id" UUID,
    "debt_id" UUID,
    "financial_goal_id" UUID,
    "snapshot_id" UUID,
    "is_large_event" BOOLEAN NOT NULL DEFAULT false,
    "is_attention_needed" BOOLEAN NOT NULL DEFAULT false,
    "visibility_level" "VisibilityLevel" NOT NULL DEFAULT 'detail',
    "status" "MoneyEventStatus" NOT NULL DEFAULT 'recorded',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "money_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attention_items" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "amount" DECIMAL(14,2),
    "related_object_type" "RelatedObjectType",
    "related_object_id" UUID,
    "level" "AttentionLevel" NOT NULL DEFAULT 'normal',
    "status" "AttentionItemStatus" NOT NULL DEFAULT 'open',
    "visibility_level" "VisibilityLevel" NOT NULL DEFAULT 'detail',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen_by" UUID,
    "seen_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "attention_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "household_members_unique" ON "household_members"("household_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "household_invites_token_key" ON "household_invites"("token");

-- CreateIndex
CREATE UNIQUE INDEX "snapshot_asset_values_unique" ON "snapshot_asset_values"("snapshot_id", "asset_id");

-- AddForeignKey
ALTER TABLE "households" ADD CONSTRAINT "households_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_holder_member_id_fkey" FOREIGN KEY ("holder_member_id") REFERENCES "household_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_market_positions" ADD CONSTRAINT "asset_market_positions_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_market_positions" ADD CONSTRAINT "asset_market_positions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_calculation_terms" ADD CONSTRAINT "asset_calculation_terms_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_calculation_terms" ADD CONSTRAINT "asset_calculation_terms_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_market_price_id_fkey" FOREIGN KEY ("market_price_id") REFERENCES "market_prices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_fx_rate_id_fkey" FOREIGN KEY ("fx_rate_id") REFERENCES "fx_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_calculation_term_id_fkey" FOREIGN KEY ("calculation_term_id") REFERENCES "asset_calculation_terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_asset_values" ADD CONSTRAINT "snapshot_asset_values_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_asset_values" ADD CONSTRAINT "snapshot_asset_values_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_asset_values" ADD CONSTRAINT "snapshot_asset_values_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_asset_values" ADD CONSTRAINT "snapshot_asset_values_valuation_id_fkey" FOREIGN KEY ("valuation_id") REFERENCES "asset_valuations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_owner_member_id_fkey" FOREIGN KEY ("owner_member_id") REFERENCES "household_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_received_to_asset_id_fkey" FOREIGN KEY ("received_to_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_terms" ADD CONSTRAINT "debt_terms_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_terms" ADD CONSTRAINT "debt_terms_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_interest_periods" ADD CONSTRAINT "debt_interest_periods_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_interest_periods" ADD CONSTRAINT "debt_interest_periods_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upcoming_payments" ADD CONSTRAINT "upcoming_payments_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upcoming_payments" ADD CONSTRAINT "upcoming_payments_owner_member_id_fkey" FOREIGN KEY ("owner_member_id") REFERENCES "household_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upcoming_payments" ADD CONSTRAINT "upcoming_payments_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upcoming_payments" ADD CONSTRAINT "upcoming_payments_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upcoming_payments" ADD CONSTRAINT "upcoming_payments_paid_from_asset_id_fkey" FOREIGN KEY ("paid_from_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upcoming_payments" ADD CONSTRAINT "upcoming_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upcoming_payments" ADD CONSTRAINT "upcoming_payments_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_goals" ADD CONSTRAINT "financial_goals_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_goals" ADD CONSTRAINT "financial_goals_linked_asset_id_fkey" FOREIGN KEY ("linked_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_goals" ADD CONSTRAINT "financial_goals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_goals" ADD CONSTRAINT "financial_goals_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_events" ADD CONSTRAINT "money_events_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_events" ADD CONSTRAINT "money_events_from_asset_id_fkey" FOREIGN KEY ("from_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_events" ADD CONSTRAINT "money_events_to_asset_id_fkey" FOREIGN KEY ("to_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_events" ADD CONSTRAINT "money_events_upcoming_payment_id_fkey" FOREIGN KEY ("upcoming_payment_id") REFERENCES "upcoming_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_events" ADD CONSTRAINT "money_events_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_events" ADD CONSTRAINT "money_events_financial_goal_id_fkey" FOREIGN KEY ("financial_goal_id") REFERENCES "financial_goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_events" ADD CONSTRAINT "money_events_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_events" ADD CONSTRAINT "money_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_events" ADD CONSTRAINT "money_events_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_seen_by_fkey" FOREIGN KEY ("seen_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

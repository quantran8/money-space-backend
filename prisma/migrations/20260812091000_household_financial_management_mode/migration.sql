-- v3.1 §7: how the couple actually manages money day to day.
--
-- Captured at onboarding step 3 ("Tôi đang giữ phần lớn" / "Người kia giữ phần
-- lớn" / "Mỗi người giữ một phần" / "Cả hai cùng quản lý" / "Chưa rõ").
--
-- Personalization and analytics ONLY. The spec is explicit that this must NOT
-- drive permissions — capability comes from household_members.role +
-- permission_level. Do not read this column in any authorization path.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FinancialManagementMode') THEN
    CREATE TYPE "FinancialManagementMode" AS ENUM (
      'one_person_primary',
      'partner_primary',
      'split_responsibility',
      'joint',
      'unsure'
    );
  END IF;
END $$;

ALTER TABLE "households"
  ADD COLUMN IF NOT EXISTS "financial_management_mode" "FinancialManagementMode"
  NOT NULL DEFAULT 'unsure';

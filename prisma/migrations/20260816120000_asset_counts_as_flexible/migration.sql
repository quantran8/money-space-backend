-- The household can now say whether a specific asset counts towards flexible
-- money, overriding what its type implies: cash held for someone else is not
-- spendable, and a gold bar they would genuinely sell this month is.
--
-- The override is stored as INTENT (`counts_as_flexible`) and materialized into
-- the existing `liquidity` column, which every consumer already reads — the
-- forecast's starting liquid balance, the dashboard, the assets summary and
-- each snapshot line. Nothing gets a second, private rule.
--
-- NULL = no decision, follow the type. Every existing row keeps exactly the
-- bucket it has today.
ALTER TABLE "assets"
  ADD COLUMN "counts_as_flexible" BOOLEAN;

-- Replace the type-only constraint: liquidity is still fully determined, now by
-- (type, counts_as_flexible) instead of type alone. An excluded cash account
-- lands in the middle bucket — money the household has but does not count on —
-- never in `long_term`.
ALTER TABLE "assets"
  DROP CONSTRAINT "assets_liquidity_matches_type";

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_liquidity_matches_type"
  CHECK (
    "liquidity" = CASE
      WHEN "counts_as_flexible" IS TRUE THEN 'usable_now'::"AssetLiquidity"
      WHEN "type" IN ('cash', 'bank_account') THEN
        CASE
          WHEN "counts_as_flexible" IS FALSE
            THEN 'not_immediately_usable'::"AssetLiquidity"
          ELSE 'usable_now'::"AssetLiquidity"
        END
      WHEN "type" IN (
        'saving_deposit',
        'certificate_of_deposit',
        'bond',
        'loan_receivable',
        'foreign_currency',
        'other'
      ) THEN 'not_immediately_usable'::"AssetLiquidity"
      ELSE 'long_term'::"AssetLiquidity"
    END
  );

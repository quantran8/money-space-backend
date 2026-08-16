-- Liquidity is classification metadata inferred from the asset type. Normalize
-- historical rows first, then prevent any client or manual write from storing
-- a conflicting bucket.
UPDATE "assets"
SET "liquidity" = CASE
  WHEN "type" IN ('cash', 'bank_account')
    THEN 'usable_now'::"AssetLiquidity"
  WHEN "type" IN (
    'saving_deposit',
    'certificate_of_deposit',
    'bond',
    'loan_receivable',
    'foreign_currency',
    'other'
  ) THEN 'not_immediately_usable'::"AssetLiquidity"
  ELSE 'long_term'::"AssetLiquidity"
END;

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_liquidity_matches_type"
  CHECK (
    ("type" IN ('cash', 'bank_account') AND "liquidity" = 'usable_now')
    OR (
      "type" IN (
        'saving_deposit',
        'certificate_of_deposit',
        'bond',
        'loan_receivable',
        'foreign_currency',
        'other'
      )
      AND "liquidity" = 'not_immediately_usable'
    )
    OR (
      "type" IN (
        'gold',
        'stock',
        'fund',
        'crypto',
        'real_estate',
        'insurance',
        'investment'
      )
      AND "liquidity" = 'long_term'
    )
  );

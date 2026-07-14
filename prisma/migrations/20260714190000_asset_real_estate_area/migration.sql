ALTER TABLE "assets"
ADD COLUMN "area_sqm" DECIMAL(14, 4);

COMMENT ON COLUMN "assets"."area_sqm" IS
  'Remaining floor or land area in square metres for real-estate assets';

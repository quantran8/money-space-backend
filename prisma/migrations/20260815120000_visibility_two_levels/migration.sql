-- Reduce VisibilityLevel from four values to two: detail | summary_only.
--
-- `private` and `grouped` are retired. `private` did two things — hid a record
-- AND removed it from every shared figure — and the second half is what made
-- the household's "shared" numbers wrong for both partners. `grouped` was
-- never exposed in any UI and never had a behaviour of its own.
--
-- Postgres cannot remove a value from an enum in place, so this creates a new
-- type, casts all five columns onto it, drops the old type and renames. Written
-- by hand rather than generated: `prisma migrate dev` emits
-- `USING "visibility_level"::text::"VisibilityLevel_new"`, which ERRORS on any
-- row still holding a retired value instead of mapping it.
--
-- Retired values fold to `summary_only`, not `detail`. A record the household
-- had chosen not to itemize must not start showing its name and holder just
-- because the app was redeployed; the amount now counts either way.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VisibilityLevel_new') THEN
    CREATE TYPE "VisibilityLevel_new" AS ENUM ('summary_only', 'detail');
  END IF;
END $$;

-- Defaults must go before the cast: Postgres cannot coerce a default
-- expression across types.
ALTER TABLE "assets"          ALTER COLUMN "visibility_level" DROP DEFAULT;
ALTER TABLE "cashflow_events" ALTER COLUMN "visibility_level" DROP DEFAULT;
ALTER TABLE "money_events"    ALTER COLUMN "visibility_level" DROP DEFAULT;
ALTER TABLE "attention_items" ALTER COLUMN "visibility_level" DROP DEFAULT;
-- `snapshot_asset_values.visibility_level` has no default.

ALTER TABLE "assets"
  ALTER COLUMN "visibility_level" TYPE "VisibilityLevel_new"
  USING (CASE WHEN "visibility_level"::text = 'detail' THEN 'detail'
              ELSE 'summary_only' END)::"VisibilityLevel_new";

ALTER TABLE "snapshot_asset_values"
  ALTER COLUMN "visibility_level" TYPE "VisibilityLevel_new"
  USING (CASE WHEN "visibility_level"::text = 'detail' THEN 'detail'
              ELSE 'summary_only' END)::"VisibilityLevel_new";

ALTER TABLE "cashflow_events"
  ALTER COLUMN "visibility_level" TYPE "VisibilityLevel_new"
  USING (CASE WHEN "visibility_level"::text = 'detail' THEN 'detail'
              ELSE 'summary_only' END)::"VisibilityLevel_new";

ALTER TABLE "money_events"
  ALTER COLUMN "visibility_level" TYPE "VisibilityLevel_new"
  USING (CASE WHEN "visibility_level"::text = 'detail' THEN 'detail'
              ELSE 'summary_only' END)::"VisibilityLevel_new";

ALTER TABLE "attention_items"
  ALTER COLUMN "visibility_level" TYPE "VisibilityLevel_new"
  USING (CASE WHEN "visibility_level"::text = 'detail' THEN 'detail'
              ELSE 'summary_only' END)::"VisibilityLevel_new";

-- Renaming back to the original name is REQUIRED, not cosmetic:
-- prisma-cashflow-events.repository.ts has a raw `::"VisibilityLevel"` cast.
DROP TYPE "VisibilityLevel";
ALTER TYPE "VisibilityLevel_new" RENAME TO "VisibilityLevel";

ALTER TABLE "assets"          ALTER COLUMN "visibility_level" SET DEFAULT 'detail';
ALTER TABLE "cashflow_events" ALTER COLUMN "visibility_level" SET DEFAULT 'detail';
ALTER TABLE "money_events"    ALTER COLUMN "visibility_level" SET DEFAULT 'detail';
ALTER TABLE "attention_items" ALTER COLUMN "visibility_level" SET DEFAULT 'detail';

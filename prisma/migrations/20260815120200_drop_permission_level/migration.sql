-- Retire PermissionLevel.
--
-- The five levels collapsed into three distinguishable outcomes in code, and
-- the three view_* tiers were behaviourally identical: `hasCapability` returned
-- the same answer for all of them, no route ever required 'view', and no read
-- path redacted anything. A `view_summary` member received the full, unredacted
-- response from every endpoint.
--
-- Membership is now the content permission. The only distinction left between
-- members is `households.created_by`, which guards the three lifecycle
-- operations — a column that already existed and that nothing renders.

ALTER TABLE "household_members" DROP COLUMN IF EXISTS "permission_level";
ALTER TABLE "household_invites" DROP COLUMN IF EXISTS "default_permission_level";

DROP TYPE IF EXISTS "PermissionLevel";

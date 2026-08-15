-- Retire HouseholdRole.
--
-- With PermissionLevel gone, `role` decided nothing: `owner | partner | viewer`
-- mapped onto a permission tier that no longer exists, and every content route
-- is gated on membership alone. Keeping it as a decorative label would be an
-- invitation to reintroduce a hierarchy, and it had already misled one check —
-- `deleteMember` guarded on `role === 'owner'` rather than on
-- `households.created_by`, which is where the real safeguard lives.
--
-- Whoever accepts an invite is an equal member. `households.created_by` remains
-- the single distinction, and it guards only the three lifecycle operations.

ALTER TABLE "household_members" DROP COLUMN IF EXISTS "role";
ALTER TABLE "household_invites" DROP COLUMN IF EXISTS "default_role";

DROP TYPE IF EXISTS "HouseholdRole";

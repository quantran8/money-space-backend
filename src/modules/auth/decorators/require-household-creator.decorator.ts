import { SetMetadata } from '@nestjs/common';

export const HOUSEHOLD_CREATOR_KEY = 'household:creator';

/**
 * Restrict a route to whoever created the household.
 *
 * This is the ONLY authorization axis above plain membership. Partners are
 * equal in everything that touches the money: any member may add, edit and
 * delete any financial record. What holds people accountable is the journal,
 * not a permission grant.
 *
 * Three operations are the exception, because they are not about money — they
 * are about the shared space itself, and each is either irreversible or
 * changes who is in the room:
 *
 *   - deleting the household
 *   - removing a member
 *   - inviting a member
 *
 * `households.created_by` carries this. No role column, no permission enum, no
 * field to render — which is what keeps hierarchy vocabulary out of the UX
 * while still leaving a safeguard on the lifecycle. `HouseholdAccessGuard`
 * already resolves the household row, so enforcing it costs nothing extra.
 *
 * If the creator ever needs to hand this over, that is
 * `POST /households/:householdId/transfer-steward` — not a permission grant.
 */
export const RequireHouseholdCreator = () =>
  SetMetadata(HOUSEHOLD_CREATOR_KEY, true);

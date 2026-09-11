import { SetMetadata } from '@nestjs/common';
import type { PremiumFeature } from '../../billing/entities/entitlement.entity';

export const REQUIRE_PREMIUM_KEY = 'billing:premium';

/**
 * Restrict a route to households on a paid plan.
 *
 * **Boolean features only.** A guard runs before the handler and knows nothing
 * about how much of anything the household has used, so it cannot enforce a
 * COUNTED quota without issuing a second query of its own — and the service is
 * about to make that query anyway. Counted limits are therefore checked in the
 * service through `EntitlementService.assertQuota()`, and only the yes/no
 * capabilities are decorated here.
 *
 * Note which routes deliberately carry no decorator:
 *
 *   - `/forecast-bundle` and the other forecast reads. They serve Free at
 *     horizon 30; only the horizon VALUE is gated, inside the service where
 *     `householdId` already is.
 *   - inviting a partner, sharing levels, the activity log, and the what-if
 *     asset-sale funding step. The first three are the core loop — a
 *     one-person household is a dead end, and the journal is what this product
 *     has instead of permissions. The funding step only appears when a
 *     household is short on money, which is exactly when they need the app
 *     most.
 */
export const RequirePremium = (feature: PremiumFeature) =>
  SetMetadata(REQUIRE_PREMIUM_KEY, feature);

import { SetMetadata } from '@nestjs/common';
import type { Capability } from '../../../common/utils/money-space.utils';

export const CAPABILITY_KEY = 'household:capability';

/**
 * Declare the capability a route handler requires ('edit' | 'admin'). The
 * `HouseholdAccessGuard` reads this and rejects members whose effective
 * permission is insufficient. Omit it for read routes ('view' is implicit for
 * any member; per-record visibility is gated at the service layer).
 */
export const RequireCapability = (capability: Capability) =>
  SetMetadata(CAPABILITY_KEY, capability);

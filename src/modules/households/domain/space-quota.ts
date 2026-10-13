import type { Entitlement } from '../../billing/entities/entitlement.entity';

export interface SpaceQuota {
  used: number;
  limit: number;
}

/** Lapsed Premium counts as Free: it may do only what Free does. */
export function isPremiumEntitlement(entitlement: Entitlement): boolean {
  return entitlement.tier === 'premium' && entitlement.status === 'active';
}

/** Spaces this user created that are on Free. Joined spaces never count. */
export function freeOwnedSpaces<T extends { id: string; createdBy: string }>(
  spaces: T[],
  userId: string,
  entitlements: ReadonlyMap<string, Entitlement>,
): T[] {
  return spaces.filter((space) => {
    if (space.createdBy !== userId) return false;
    const entitlement = entitlements.get(space.id);
    return !entitlement || !isPremiumEntitlement(entitlement);
  });
}

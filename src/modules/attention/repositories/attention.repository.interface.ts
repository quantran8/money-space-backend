import type { Household } from '../../households/entities/household.entity';

export const ATTENTION_REPOSITORY = Symbol('ATTENTION_REPOSITORY');

/**
 * Attention signals are DERIVED on every read and never stored, so this holds
 * only what the derivation needs from the database — which is just the
 * household row that proves the household exists.
 *
 * The stored-item and dismissal-tombstone methods went with the
 * `attention_items` table (2026-08-29); see `attention.service.ts`.
 */
export interface AttentionRepository {
  assertHousehold(householdId: string): Promise<Household>;
}

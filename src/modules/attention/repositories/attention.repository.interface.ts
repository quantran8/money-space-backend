import type { Household } from '../../households/entities/household.entity';
import type {
  AttentionItemStatus,
  StoredAttentionItem,
} from '../entities/attention-item.entity';
import type {
  AttentionLevel,
  AttentionRelatedObjectType,
  AttentionRuleCode,
} from '../domain/attention-rules';

export const ATTENTION_REPOSITORY = Symbol('ATTENTION_REPOSITORY');

export interface InsertAttentionItemInput {
  id: string;
  householdId: string;
  title: string;
  reason?: string | null;
  ruleCode: AttentionRuleCode;
  level?: AttentionLevel;
  status?: AttentionItemStatus;
  amount?: number | null;
  relatedObjectType?: AttentionRelatedObjectType | null;
  relatedObjectId?: string | null;
  createdById?: string | null;
}

/** A dismissal of a DERIVED signal, keyed the same way the derivation is. */
export interface DismissalTombstone {
  ruleCode: AttentionRuleCode;
  relatedObjectId: string | null;
}

export interface AttentionRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  /**
   * Stored items that are still live (`open` / `seen`). Resolved and dismissed
   * rows are excluded — the latter are read separately as tombstones.
   */
  findOpenStoredItems(householdId: string): Promise<StoredAttentionItem[]>;
  findStoredItemById(
    householdId: string,
    itemId: string,
  ): Promise<StoredAttentionItem | undefined>;
  /**
   * Every dismissal recorded for this household, so a derived signal the user
   * has already waved off is never re-raised.
   */
  findDismissals(householdId: string): Promise<DismissalTombstone[]>;
  insertItem(input: InsertAttentionItemInput): Promise<void>;
  markSeen(itemId: string, userId: string | null): Promise<void>;
  markResolved(itemId: string, userId: string | null): Promise<void>;
  markDismissed(itemId: string, userId: string | null): Promise<void>;
  /** Count of stored open items — what a snapshot freezes (§29). */
  countOpenStoredItems(householdId: string): Promise<number>;
}

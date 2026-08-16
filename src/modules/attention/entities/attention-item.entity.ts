import type {
  AttentionLevel,
  AttentionRelatedObjectType,
  AttentionRuleCode,
} from '../domain/attention-rules';

export type AttentionItemStatus = 'open' | 'seen' | 'resolved' | 'dismissed';

/**
 * One attention signal as the API returns it — the shape is identical whether
 * the signal was read from `attention_items` or derived from the live forecast,
 * so a client renders one list without branching. `source` says which it was.
 *
 * `title` / `reason` are free text ONLY on stored, user-authored items. Derived
 * signals leave them null and carry `ruleCode` + `params` instead: the client
 * owns all copy (hard i18n mandate), so the backend must not invent sentences.
 */
export interface AttentionItemView {
  id: string;
  source: 'stored' | 'derived';
  ruleCode: AttentionRuleCode;
  title: string | null;
  reason: string | null;
  level: AttentionLevel;
  status: AttentionItemStatus;
  amount: number | null;
  relatedObjectType: AttentionRelatedObjectType | null;
  relatedObjectId: string | null;
  params: Record<string, string | number | boolean>;
  createdAt: string | null;
}

/** A stored row, as the repository returns it. */
export interface StoredAttentionItem {
  id: string;
  householdId: string;
  title: string;
  reason: string | null;
  ruleCode: AttentionRuleCode | null;
  level: AttentionLevel;
  status: AttentionItemStatus;
  amount: number | null;
  relatedObjectType: AttentionRelatedObjectType | null;
  relatedObjectId: string | null;
  createdAt: string;
}

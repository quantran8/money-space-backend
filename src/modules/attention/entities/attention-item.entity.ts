import type {
  AttentionLevel,
  AttentionRelatedObjectType,
  AttentionRuleCode,
} from '../domain/attention-rules';

/**
 * One attention signal as the API returns it.
 *
 * Every signal is DERIVED from the live forecast, so it carries no free text:
 * the client owns all copy (hard i18n mandate) and renders the sentence from
 * `ruleCode` + `params`. The stored/dismissed variants went with the
 * `attention_items` table (2026-08-29) — see `attention.service.ts`.
 */
export interface AttentionItemView {
  id: string;
  ruleCode: AttentionRuleCode;
  level: AttentionLevel;
  amount: number | null;
  relatedObjectType: AttentionRelatedObjectType | null;
  relatedObjectId: string | null;
  params: Record<string, string | number | boolean>;
}

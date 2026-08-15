/**
 * The journal's vocabulary.
 *
 * With no permission hierarchy between partners, the journal is what makes a
 * change accountable — it is the mechanism that replaced the permission grant,
 * not a debugging aid. Two rules follow from that:
 *
 * 1. **Codes, never sentences.** The client owns all copy (hard i18n mandate),
 *    exactly as the forecast's `CalculationAssumption` already works. A backend
 *    string here could not be translated or restyled.
 * 2. **If a change cannot say how it moved the picture, it should not be
 *    logged.** The impact is what separates this from a technical audit log.
 *    Routine `income` / `expense` money events are deliberately absent: logging
 *    every purchase would turn the product into the expense tracker it
 *    explicitly is not.
 */
export type AuditAction =
  // Assets
  | 'asset.created'
  | 'asset.deleted'
  | 'asset.value_updated'
  | 'asset.liquidity_changed'
  | 'asset.sold'
  // Upcoming money
  | 'cashflow_event.added'
  | 'cashflow_event.completed'
  | 'cashflow_event.cancelled'
  | 'cashflow_event.postponed'
  // The forecast's floor
  | 'protected_reserve.created'
  | 'protected_reserve.updated'
  | 'protected_reserve.archived'
  // Goals
  | 'goal.created'
  | 'goal.target_changed'
  // Sharing
  | 'record.visibility_changed'
  // Lifecycle — under this model the journal is their only visible trace
  | 'household.created'
  | 'household.deleted'
  | 'household.member_joined'
  | 'household.member_removed'
  | 'household.invite_created'
  | 'household.invite_revoked'
  | 'household.steward_transferred'
  // Snapshots and corrections
  | 'snapshot.created'
  | 'debt.corrected';

export type AuditEntityType =
  | 'asset'
  | 'cashflow_event'
  | 'protected_reserve'
  | 'financial_goal'
  | 'debt'
  | 'snapshot'
  | 'household'
  | 'household_member'
  | 'household_invite';

/** Which shared figure a change moved, and by how much. */
export type AuditImpactMetric =
  | 'liquid'
  | 'net_worth'
  | 'flexible_money'
  | 'upcoming_outgoing'
  | 'protected_reserve';

export interface AuditImpact {
  metric: AuditImpactMetric;
  /** Signed, in VND. */
  delta: number;
}

export interface AuditRecordInput {
  /** NULL means the actor was the system (a worker, a cron, a migration). */
  actorId?: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  /**
   * The record's own delta — the asset's value change, the reserve's amount
   * change. Deliberately NOT a before/after re-run of the forecast: that would
   * double the cost of every write for a column the client only labels.
   */
  impact?: AuditImpact | null;
  /** Anything else the client needs to build a sentence. Never prose. */
  details?: Record<string, unknown>;
}

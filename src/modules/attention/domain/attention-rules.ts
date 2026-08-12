/**
 * Attention signals (spec §29) — the pure derivation half.
 *
 * The single most important design decision in this file is what it does NOT
 * do: **it never writes.**
 *
 * Most attention signals are statements about the household's CURRENT
 * situation — "a required payment is overdue", "the projected balance dips
 * below zero", "these asset values are stale". Those conditions clear on their
 * own the moment the household acts. Persisting them would be a bug:
 * `attention_items` has no `deleted_at`, so the only "gone" state is
 * `dismissed` — meaning a stale persisted signal becomes indistinguishable
 * from something the user deliberately dismissed. The row would outlive the
 * fact it described, and nothing could tell the difference.
 *
 * So derived signals are recomputed from the forecast bundle on every read
 * (zero marginal queries — the bundle is already in memory) and merged with
 * genuinely-stored ones at the API boundary. See `attention.service.ts`.
 *
 * Everything here emits CODES and structured params, never sentences: the
 * client owns all copy, and §29's calm-tone rules are a copy concern.
 */

import type { IsoDate } from '../../../common/utils/clock';
import { daysBetweenIso } from '../../../common/utils/clock';
import type { ForecastResult } from '../../forecast/domain/forecast.types';
import type { FlexibleMoneyResult } from '../../forecast/domain/flexible-money';

/** Signals computed from the live picture. Never persisted. */
export type DerivedAttentionRuleCode =
  | 'cashflow_required_due_soon'
  | 'cashflow_overdue'
  | 'low_projected_balance'
  | 'reserve_at_risk'
  | 'stale_data';

/** Signals that are genuine point-in-time records, so they ARE persisted. */
export type StoredAttentionRuleCode =
  | 'user_flagged'
  | 'money_event_flagged'
  | 'asset_moved_sharply'
  /** Dormant until a household sets `config.largeEventThresholdVnd` (§29). */
  | 'amount_over_threshold';

export type AttentionRuleCode =
  | DerivedAttentionRuleCode
  | StoredAttentionRuleCode;

export type AttentionLevel = 'normal' | 'important' | 'urgent';

export type AttentionRelatedObjectType =
  | 'asset'
  | 'cashflow_event'
  | 'financial_goal'
  | 'snapshot'
  | 'money_event'
  | 'debt';

export interface DerivedAttentionItem {
  /**
   * Synthetic and STABLE across reads — `derived:<ruleCode>:<scope>`. Not a
   * database id; a client must never PATCH it. Stability is what lets a
   * dismissal taken on one read still apply on the next.
   */
  id: string;
  source: 'derived';
  ruleCode: DerivedAttentionRuleCode;
  level: AttentionLevel;
  amount: number | null;
  relatedObjectType: AttentionRelatedObjectType | null;
  relatedObjectId: string | null;
  /** Machine values for the client to render its own sentence. Never text. */
  params: Record<string, string | number | boolean>;
}

export interface DeriveAttentionInput {
  asOfDate: IsoDate;
  forecast: ForecastResult;
  flexible: FlexibleMoneyResult;
  /** Assets whose value is older than the household's update cadence. */
  staleAssets?: { assetId: string; name: string; daysSinceUpdate: number }[];
}

/**
 * Exported so a threshold change is a deliberate edit against a failing test,
 * rather than a magic number drifting inside a conditional.
 */
export const ATTENTION_THRESHOLDS = {
  /** A required outflow within this many days is worth surfacing. */
  dueSoonDays: 7,
  /** Below reserve × this → the reserve is materially at risk, not brushed. */
  reserveAtRiskRatio: 1,
} as const;

/**
 * Build a stable derived id. The scope is the related object when the signal is
 * about one, otherwise the household-level constant `household` — so
 * `low_projected_balance` collapses to exactly one signal instead of one per
 * contributing event.
 */
export function derivedAttentionId(
  ruleCode: DerivedAttentionRuleCode,
  scope: string | null,
): string {
  return `derived:${ruleCode}:${scope ?? 'household'}`;
}

/**
 * Derive every attention signal implied by the current forecast.
 *
 * Pure: takes an `asOfDate`, reads no clock, touches no database, returns a new
 * array. Called on the already-loaded forecast bundle, so it costs no queries.
 */
export function deriveAttentionItems(
  input: DeriveAttentionInput,
): DerivedAttentionItem[] {
  const { asOfDate, forecast, flexible } = input;
  const items: DerivedAttentionItem[] = [];

  // --- per-event signals ---------------------------------------------------
  //
  // Only `required` outgoing money raises a signal. A `planned` purchase that
  // hasn't happened is not a problem the household needs told about — treating
  // a choice like an obligation is exactly the nagging §29 forbids.
  //
  // Occurrences are grouped by SOURCE EVENT, not by occurrence: a monthly rent
  // series must produce one signal, not one per month in the horizon. The
  // earliest occurrence wins, since that's the one to act on.
  const seenEventIds = new Set<string>();

  for (const occurrence of forecast.timeline) {
    if (occurrence.direction !== 'outgoing') continue;
    if (occurrence.requirement !== 'required') continue;
    if (occurrence.isSynthetic) continue;
    if (seenEventIds.has(occurrence.sourceEventId)) continue;

    const daysUntil = daysBetweenIso(asOfDate, occurrence.date);

    // An overdue occurrence was clamped onto today by the forecast, so its
    // `date` reads as today. `wasClampedFromPast` is the only surviving
    // evidence that it was actually late — check it before the due-soon test,
    // or every overdue bill would report as "due in 0 days".
    if (occurrence.wasClampedFromPast) {
      seenEventIds.add(occurrence.sourceEventId);
      items.push({
        id: derivedAttentionId('cashflow_overdue', occurrence.sourceEventId),
        source: 'derived',
        ruleCode: 'cashflow_overdue',
        level: 'important',
        amount: occurrence.amount,
        relatedObjectType: 'cashflow_event',
        relatedObjectId: occurrence.sourceEventId,
        params: { expectedDate: occurrence.date, amount: occurrence.amount },
      });
      continue;
    }

    if (daysUntil >= 0 && daysUntil <= ATTENTION_THRESHOLDS.dueSoonDays) {
      seenEventIds.add(occurrence.sourceEventId);
      items.push({
        id: derivedAttentionId(
          'cashflow_required_due_soon',
          occurrence.sourceEventId,
        ),
        source: 'derived',
        ruleCode: 'cashflow_required_due_soon',
        level: 'normal',
        amount: occurrence.amount,
        relatedObjectType: 'cashflow_event',
        relatedObjectId: occurrence.sourceEventId,
        params: {
          expectedDate: occurrence.date,
          daysUntil,
          amount: occurrence.amount,
        },
      });
    }
  }

  // --- household-level signals --------------------------------------------

  // The forecast dips below zero at some point in the horizon. This is the
  // signal the whole product exists to surface, so it is the one `urgent`
  // level here — see 05 §2.
  if (forecast.lowestProjectedBalance < 0) {
    items.push({
      id: derivedAttentionId('low_projected_balance', null),
      source: 'derived',
      ruleCode: 'low_projected_balance',
      level: 'urgent',
      amount: forecast.lowestProjectedBalance,
      relatedObjectType: null,
      relatedObjectId: null,
      params: {
        lowestProjectedBalance: forecast.lowestProjectedBalance,
        lowestProjectedBalanceDate: forecast.lowestProjectedBalanceDate,
        horizonDays: forecast.horizonDays,
      },
    });
  }

  // The reserve gets breached but the balance still stays positive. Reported
  // separately and only when NOT already negative: two signals about the same
  // dip would double-count the same worry.
  if (
    forecast.protectedReserveAmount > 0 &&
    forecast.lowestProjectedBalance >= 0 &&
    forecast.lowestProjectedBalance <
      forecast.protectedReserveAmount * ATTENTION_THRESHOLDS.reserveAtRiskRatio
  ) {
    items.push({
      id: derivedAttentionId('reserve_at_risk', null),
      source: 'derived',
      ruleCode: 'reserve_at_risk',
      level: 'important',
      amount: flexible.flexibleMoneyHorizon,
      relatedObjectType: null,
      relatedObjectId: null,
      params: {
        protectedReserveAmount: forecast.protectedReserveAmount,
        lowestProjectedBalance: forecast.lowestProjectedBalance,
        lowestProjectedBalanceDate: forecast.lowestProjectedBalanceDate,
      },
    });
  }

  // Stale values are a data-quality signal, never a judgement: the household
  // isn't doing anything wrong, the picture is just older than it looks. One
  // signal per stale asset so the client can link straight to it.
  for (const asset of input.staleAssets ?? []) {
    items.push({
      id: derivedAttentionId('stale_data', asset.assetId),
      source: 'derived',
      ruleCode: 'stale_data',
      level: 'normal',
      amount: null,
      relatedObjectType: 'asset',
      relatedObjectId: asset.assetId,
      params: { daysSinceUpdate: asset.daysSinceUpdate },
    });
  }

  return items;
}

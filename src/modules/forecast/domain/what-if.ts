/**
 * What-if (spec §26D, 05 §5) — the feature people pay for.
 *
 * "If I spend 30M on the 20th, what happens?" Answered by building a synthetic
 * outgoing event **in memory**, re-running the forecast, and diffing.
 *
 * Three invariants:
 *
 * 1. **Nothing is persisted.** There is no `what_if_scenarios` table and there
 *    must not be one (§2.12). The synthetic event never reaches a repository.
 * 2. **It is a read.** Running a simulation is not editing the household, so it
 *    must stay available to a `view_summary` partner even though it is a POST.
 * 3. **It reports consequence, never a verdict.** The result says what changes;
 *    it never says whether to buy. `resultType` is a calm classification for
 *    styling, not advice.
 */

import type { IsoDate } from '../../../common/utils/clock';
import { SELLABLE_ASSET_TYPES } from '../../assets/entities/asset.entity';
import type {
  ForecastCashflowEvent,
  ForecastLiquidSource,
  ForecastResult,
} from './forecast.types';

export type WhatIfResultType = 'comfortable' | 'tight' | 'not_covered';

/** The sale as the caller asked for it, once validated. */
export interface AppliedAssetSale {
  assetId: string;
  amount: number;
  receivingAssetId: string;
}

/**
 * Can this asset fund a spend by being sold?
 *
 * `usable_now` is excluded because a wallet is transferred from, not sold.
 * Sellability itself stays `SELLABLE_ASSET_TYPES` so a simulated sale and a
 * real one can never disagree about what is sellable.
 */
export function isSellableForecastAsset(source: ForecastLiquidSource): boolean {
  return (
    source.liquidity !== 'usable_now' && SELLABLE_ASSET_TYPES.has(source.type)
  );
}

/**
 * The sale, as the forecast sees it: value moves from the sold asset into a
 * wallet at t0. A conversion, not an event — see [[asset-sale]].
 *
 * Deliberately NOT a synthetic incoming event: see
 * memory/forecast-and-flexible-money.md for why that shape reports a wrong
 * flexible-money figure and charges the goals twice.
 */
export function applyAssetSale(
  assets: ForecastLiquidSource[],
  sale: AppliedAssetSale,
): ForecastLiquidSource[] {
  return assets.map((asset) => {
    if (asset.assetId === sale.assetId) {
      return { ...asset, value: asset.value - sale.amount };
    }
    if (asset.assetId === sale.receivingAssetId) {
      return { ...asset, value: asset.value + sale.amount };
    }
    return asset;
  });
}

/**
 * The spend, as the forecast sees it.
 *
 * `requirement: 'planned'` because a discretionary purchase is a choice, not an
 * obligation — so it moves the running balance without making the household
 * "not covered". `certainty: 'confirmed'` because if you're asking, you would
 * actually spend it.
 */
export function buildSyntheticEvent(params: {
  amount: number;
  plannedDate: IsoDate;
  label?: string;
}): ForecastCashflowEvent {
  return {
    id: 'what-if',
    name: params.label ?? 'what-if',
    direction: 'outgoing',
    amount: params.amount,
    expectedDate: params.plannedDate,
    recurrence: 'once',
    recurrenceEndDate: null,
    requirement: 'planned',
    certainty: 'confirmed',
    status: 'expected',
    isSynthetic: true,
  };
}

/**
 * Classify the after-picture. Ordered most-severe first so the label reflects
 * the worst thing that happens, not the first thing checked.
 */
export function classifyResult(after: ForecastResult): WhatIfResultType {
  if (!after.obligationsCovered) return 'not_covered';
  if (after.lowestProjectedBalance < 0) return 'tight';
  return 'comfortable';
}

/**
 * Bucket an amount for analytics (§26D).
 *
 * Only the bucket is ever emitted — never the amount, never the balances. The
 * product's promise is that a couple's finances stay theirs; shipping the real
 * figures to an analytics pipeline would quietly break that.
 */
export function amountBucket(amount: number): string {
  const millions = amount / 1_000_000;
  if (millions < 1) return '<1M';
  if (millions < 5) return '1-5M';
  if (millions < 10) return '5-10M';
  if (millions < 50) return '10-50M';
  if (millions < 100) return '50-100M';
  return '100M+';
}

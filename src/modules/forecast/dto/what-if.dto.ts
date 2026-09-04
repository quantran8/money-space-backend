/**
 * The optional second step: "…and to pay for it, we sell part of an asset."
 *
 * A conversion, not income (see [[asset-sale]]): the sold asset goes down, a
 * wallet goes up, and net worth is unchanged. Nothing is written — this is the
 * shape of a sale, held in memory for the length of one request.
 */
export interface WhatIfAssetSaleDto {
  /** Must be an active, non-`usable_now`, sellable asset of the household. */
  assetId: string;
  /**
   * Gross proceeds, in VND — the same meaning `money_events.amount` carries for
   * an `asset_sale`. A hypothetical carries no fee, so the wallet is credited
   * this same figure.
   */
  amount: number;
  /**
   * The wallet the proceeds land in. Required: a real sale names one
   * (`money_events.to_asset_id`), and which account holds the cash decides
   * which goals it is sitting in front of. Must be `usable_now`.
   */
  toAssetId: string;
}

export interface WhatIfRequestDto {
  /** Must be positive. */
  amount: number;
  /** Must fall inside the forecast horizon. */
  plannedDate: string;
  /** Optional: show the time cost against a specific goal. */
  goalId?: string;
  label?: string;
  /**
   * `true` when the money would come straight out of what's saved for the goal
   * (so progress drops); `false` when it displaces future contributions.
   * See 05 §5.
   *
   * Preview only — this endpoint persists nothing (§26D). The real action is an
   * `expense` that debits the goal's backing asset; progress follows on the
   * next read.
   */
  takeFromGoal?: boolean;
  horizonDays?: number;
  /** Optional step 2. Absent = the simulation behaves exactly as before. */
  assetSale?: WhatIfAssetSaleDto;
}

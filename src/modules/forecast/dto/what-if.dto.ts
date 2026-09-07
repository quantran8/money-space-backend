/**
 * The optional second step: "…and to pay for it, we sell part of an asset."
 *
 * A conversion, not income (see [[asset-sale]]): the sold asset goes down, a
 * wallet goes up, and net worth is unchanged. Nothing is written — this is the
 * shape of a sale, held in memory for the length of one request.
 */
// Owned by the pure domain so the engine needs no DTO import.
export { UNASSIGNED_WALLET_ID } from '../domain/what-if';

/** One holding being sold. */
export interface WhatIfAssetSaleLineDto {
  /** Must be an active, non-`usable_now`, sellable asset of the household. */
  assetId: string;
  /** Gross proceeds, in VND. A hypothetical carries no fee. */
  amount: number;
}

export interface WhatIfAssetSaleDto {
  /** The holdings being sold — one is often not enough to close the gap. */
  lines: WhatIfAssetSaleLineDto[];
  /**
   * The wallet the proceeds land in. Must be `usable_now`, or
   * `UNASSIGNED_WALLET_ID` when the household holds no such wallet.
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
  /**
   * `true` when this re-runs the question already on screen — the household
   * added an asset sale to it, or took one away — rather than asking a new one.
   *
   * A quota slot is one QUESTION: input entered, "Xem thử" pressed, an answer
   * shown. Exploring that answer through the funding step is part of the same
   * question, so a re-run is still checked against the ceiling but does not
   * spend another slot. Re-entering the same amount and asking again IS a new
   * question, which is why this is a flag from the client and not something the
   * server infers by comparing payloads.
   */
  rerun?: boolean;
}

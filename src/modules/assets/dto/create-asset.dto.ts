import type { AssetType, AssetValuationMode } from '../entities/asset.entity';
import type { CalculationTerm } from '../entities/calculation-term.entity';
import type { MarketPosition } from '../entities/market-position.entity';

export interface CreateAssetDto {
  name: string;
  type: AssetType;
  valuationMode?: AssetValuationMode;
  currency?: string;
  note?: string;
  areaSqm?: number;
  manualValue?: number;
  marketPosition?: MarketPosition;
  calculationTerm?: CalculationTerm;
  /** Who is responsible for this money. */
  holderMemberId?: string | null;
  /**
   * Whether this asset counts towards flexible money, overriding what its type
   * implies. Omit (or null) to follow the type. This is the ONE liquidity input
   * a client may send — the bucket itself is still derived, never posted.
   */
  countsAsFlexible?: boolean | null;
  /**
   * The wallet this asset was BOUGHT with, when the household is recording a
   * purchase rather than declaring something it already owns. Two different
   * acts, and the app must not conflate them:
   *
   * - omitted / null — "we already have this" (gold bought in 2020, only now
   *   entered). Net worth RISES: the household is no poorer, it is just newly
   *   recorded. No money event, no wallet touched.
   * - a wallet id — "we just bought this". Net worth stays PUT: money left the
   *   wallet and came back as the asset. Logs an `asset_purchase` outflow and
   *   debits the wallet.
   *
   * Deliberately not a column on `assets`: this describes ONE acquisition, not
   * the asset. Buying more of the same position later would have no single
   * value to store. Purchase history lives in `money_events`, next to
   * `asset_sale`.
   */
  fundingAssetId?: string | null;
}

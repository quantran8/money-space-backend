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
}

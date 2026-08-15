import type {
  AssetLiquidity,
  AssetType,
  AssetValuationMode,
  VisibilityLevel,
} from '../entities/asset.entity';
import type { CalculationTerm } from '../entities/calculation-term.entity';
import type { MarketPosition } from '../entities/market-position.entity';

export interface CreateAssetDto {
  name: string;
  type: AssetType;
  valuationMode?: AssetValuationMode;
  liquidity: AssetLiquidity;
  currency?: string;
  note?: string;
  areaSqm?: number;
  manualValue?: number;
  marketPosition?: MarketPosition;
  calculationTerm?: CalculationTerm;
  /**
   * Defaults to `detail`. Any member may set or change it — it is a
   * presentation choice, not a permission, and the change is journalled.
   */
  visibilityLevel?: VisibilityLevel;
  /** Who is responsible for this money. */
  holderMemberId?: string | null;
}

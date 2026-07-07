import type {
  AssetLiquidity,
  AssetType,
  AssetValuationMode,
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
  manualValue?: number;
  marketPosition?: MarketPosition;
  calculationTerm?: CalculationTerm;
}

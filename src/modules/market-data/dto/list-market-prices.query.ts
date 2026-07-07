import type { AssetClass } from '../../assets/entities/asset.entity';

export interface ListMarketPricesQuery {
  assetClass?: AssetClass;
  symbol?: string;
}

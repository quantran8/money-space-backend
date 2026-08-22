import { Injectable } from '@nestjs/common';
import { mapFxRate } from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import type { AssetClass } from '../../assets/entities/asset.entity';
import { FxRate } from '../entities/fx-rate.entity';
import type { SymbolRequest } from '../providers/symbol-request';
import { MarketDataRepository } from './market-data.repository.interface';

/** Classes the batched provider can price; gold & FX stay on other sources. */
const PROVIDER_ASSET_CLASSES: AssetClass[] = ['stock', 'fund', 'crypto'];

@Injectable()
export class PrismaMarketDataRepository
  extends PrismaRepository
  implements MarketDataRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async getFxRates(): Promise<FxRate[]> {
    const rates = await this.findLatestFxRates();
    return rates.map((rate) => mapFxRate(rate));
  }

  async getMarketSymbolUniverse(): Promise<SymbolRequest[]> {
    const rows = await this.prisma.assetMarketPosition.findMany({
      where: {
        deletedAt: null,
        // The POSITION being live is not enough — its asset has to be live too.
        // Assets are soft-deleted, so the position outlives the asset and would
        // otherwise keep this symbol in the universe forever: the provider gets
        // polled, on every refresh, for a holding no household still has.
        asset: { deletedAt: null },
        symbol: { not: null },
        assetClass: { in: PROVIDER_ASSET_CLASSES },
      },
      select: {
        assetClass: true,
        symbol: true,
        market: true,
        priceSourceSymbol: true,
        quoteCurrency: true,
      },
    });

    // Collapse to distinct (assetClass, symbol, market) — many households hold
    // the same ticker; the provider only needs to price each once.
    const seen = new Map<string, SymbolRequest>();
    for (const row of rows) {
      if (!row.symbol) continue;
      // `market` joins the key: the same ticker on two venues is two distinct
      // instruments (and may route to different providers).
      const key = `${row.assetClass}:${row.symbol.toUpperCase()}:${
        row.market?.toUpperCase() ?? ''
      }`;
      if (seen.has(key)) continue;
      seen.set(key, {
        assetClass: row.assetClass,
        symbol: row.symbol,
        market: row.market ?? undefined,
        providerSymbol: row.priceSourceSymbol ?? undefined,
        quoteCurrency: row.quoteCurrency,
      });
    }
    return [...seen.values()];
  }
}

import { Injectable } from '@nestjs/common';
import {
  mapFxRate,
  mapMarketPrice,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { FxRate } from '../entities/fx-rate.entity';
import { MarketPrice } from '../entities/market-price.entity';
import { MarketDataRepository } from './market-data.repository.interface';

@Injectable()
export class PrismaMarketDataRepository
  extends PrismaRepository
  implements MarketDataRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  // The `/market-data/prices` + `/fx-rates` endpoints show the CURRENT rate
  // board (one row per instrument), not the full tick history — so they read
  // the latest row per key, which also keeps the query bounded as history grows.
  async getMarketPrices(): Promise<MarketPrice[]> {
    const prices = await this.findLatestMarketPrices();
    return prices.map((price) => mapMarketPrice(price));
  }

  async getFxRates(): Promise<FxRate[]> {
    const rates = await this.findLatestFxRates();
    return rates.map((rate) => mapFxRate(rate));
  }
}

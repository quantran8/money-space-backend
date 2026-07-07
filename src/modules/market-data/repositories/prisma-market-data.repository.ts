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

  async getMarketPrices(): Promise<MarketPrice[]> {
    const prices = await this.prisma.marketPrice.findMany({
      orderBy: { priceTime: 'desc' },
    });

    return prices.map((price) => mapMarketPrice(price));
  }

  async getFxRates(): Promise<FxRate[]> {
    const rates = await this.prisma.fxRate.findMany({
      orderBy: { rateTime: 'desc' },
    });

    return rates.map((rate) => mapFxRate(rate));
  }
}

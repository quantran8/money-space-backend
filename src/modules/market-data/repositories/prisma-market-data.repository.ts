import { Injectable } from '@nestjs/common';
import { mapFxRate } from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { FxRate } from '../entities/fx-rate.entity';
import { MarketDataRepository } from './market-data.repository.interface';

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
}

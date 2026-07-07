import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const FALLBACK_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/money_space?schema=public';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly shouldConnect: boolean;

  constructor() {
    const url = process.env.DATABASE_URL ?? FALLBACK_DATABASE_URL;

    super({
      datasources: {
        db: {
          url,
        },
      },
    });

    this.shouldConnect =
      Boolean(process.env.DATABASE_URL) && process.env.NODE_ENV !== 'test';
  }

  async onModuleInit() {
    if (!this.shouldConnect) {
      return;
    }

    await this.$connect();
  }

  async onModuleDestroy() {
    if (!this.shouldConnect) {
      return;
    }

    await this.$disconnect();
  }
}

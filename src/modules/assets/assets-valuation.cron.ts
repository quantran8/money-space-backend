import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AssetsService } from './assets.service';
import { ASSETS_REPOSITORY } from './repositories/assets.repository.interface';
import type { AssetsRepository } from './repositories/assets.repository.interface';
import { Inject } from '@nestjs/common';
import { todayInTimeZone } from '../../common/utils/clock';
import { withAdvisoryLock } from '../../common/utils/advisory-lock';
import { PrismaService } from '../../database/prisma/prisma.service';

/** Kept below the DB pool budget so the job never starves live requests. */
const DEFAULT_CONCURRENCY = 3;

/** Leftovers resume on the next run. */
const DEFAULT_BATCH_LIMIT = 500;

/**
 * End-of-day capture of every market asset's value, so history has a point for
 * every day rather than only the days someone opened the app.
 *
 * Schedule, the settled-vs-live split and the multi-instance behaviour are in
 * `memory/market-data.md`.
 */
@Injectable()
export class AssetsValuationCron {
  /** Cluster-wide lock name; see `withAdvisoryLock`. */
  private static readonly LOCK_NAME = 'assets:daily-valuation';

  private readonly logger = new Logger(AssetsValuationCron.name);
  private running = false;

  constructor(
    private readonly assetsService: AssetsService,
    @Inject(ASSETS_REPOSITORY)
    private readonly assetsRepository: AssetsRepository,
    private readonly prisma: PrismaService,
  ) {}

  /** 23:45 VN: end of day for every asset class, still the same date. */
  @Cron('45 23 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async captureDailyValuations(): Promise<void> {
    if (process.env.MARKET_VALUATION_CRON_ENABLED === 'false') return;
    await this.run();
  }

  /** Separate from the scheduled method so it can be driven directly. */
  async run(): Promise<{ households: number; assets: number }> {
    // Per-process guard; the advisory lock below covers other instances.
    if (this.running) {
      this.logger.warn('Daily valuation already running — skipping this tick');
      return { households: 0, assets: 0 };
    }
    this.running = true;

    try {
      const result = await withAdvisoryLock(
        this.prisma,
        AssetsValuationCron.LOCK_NAME,
        () => this.captureAll(),
      );
      if (!result) {
        this.logger.log(
          'Daily valuation: another instance holds the lock — skipping',
        );
        return { households: 0, assets: 0 };
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /** The actual batch, once this instance holds the lock. */
  private async captureAll(): Promise<{ households: number; assets: number }> {
    const startedAt = Date.now();

    // Resolved once: a batch crossing midnight must not split across two dates.
    const valuationDate = todayInTimeZone();
    const householdIds =
      await this.assetsRepository.findHouseholdsNeedingMarketValuation(
        valuationDate,
        this.batchLimit(),
      );

    if (householdIds.length === 0) {
      this.logger.log(`Daily valuation: nothing to do for ${valuationDate}`);
      return { households: 0, assets: 0 };
    }

    let assets = 0;
    let failed = 0;
    for (const chunk of this.chunked(householdIds, this.concurrency())) {
      const results = await Promise.all(
        chunk.map(async (householdId) => {
          try {
            const result = await this.assetsService.refreshMarketValuations(
              householdId,
              valuationDate,
            );
            return result.refreshed;
          } catch (error) {
            // One household's failure must not abandon the rest of the batch.
            failed += 1;
            this.logger.error(
              `Daily valuation failed for household ${householdId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return 0;
          }
        }),
      );
      assets += results.reduce((sum, n) => sum + n, 0);
    }

    this.logger.log(
      `Daily valuation ${valuationDate}: ${householdIds.length} household(s), ` +
        `${assets} asset(s), ${failed} failed, ${Date.now() - startedAt}ms`,
    );
    return { households: householdIds.length, assets };
  }

  private concurrency(): number {
    const raw = Number(process.env.MARKET_VALUATION_CONCURRENCY);
    return Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : DEFAULT_CONCURRENCY;
  }

  private batchLimit(): number {
    const raw = Number(process.env.MARKET_VALUATION_BATCH_LIMIT);
    return Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : DEFAULT_BATCH_LIMIT;
  }

  private *chunked<T>(items: T[], size: number): Generator<T[]> {
    for (let i = 0; i < items.length; i += size) {
      yield items.slice(i, i + size);
    }
  }
}

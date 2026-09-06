import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AssetsService } from './assets.service';
import { MoneyEventsService } from '../money-events/money-events.service';
import { ASSETS_REPOSITORY } from './repositories/assets.repository.interface';
import type { AssetsRepository } from './repositories/assets.repository.interface';
import { todayInTimeZone } from '../../common/utils/clock';
import { withAdvisoryLock } from '../../common/utils/advisory-lock';
import { PrismaService } from '../../database/prisma/prisma.service';

/** Kept below the DB pool budget so the job never starves live requests. */
const DEFAULT_CONCURRENCY = 3;

/** Leftovers resume on the next run. */
const DEFAULT_BATCH_LIMIT = 500;

/**
 * Nightly life of a saving deposit: credit the interest that has fallen due,
 * then settle the deposits that have reached maturity.
 *
 * Before this, neither happened. Accrual existed but its only triggers were two
 * `@Public()` endpoints meant for an external worker that was never built, so
 * no interest had ever been credited and every deposit's value chart was a flat
 * line. Maturity had no handling at all — a matured passbook sat at its
 * principal forever.
 *
 * The two passes are ONE job, in this order, on purpose: a deposit that
 * capitalizes needs its final interest folded into the principal before that
 * principal is paid out. Splitting them into two crons would make that ordering
 * a scheduling coincidence rather than a guarantee.
 *
 * See memory/asset-valuation.md.
 */
@Injectable()
export class SavingDepositCron {
  /** Cluster-wide lock name; see `withAdvisoryLock`. */
  private static readonly LOCK_NAME = 'assets:saving-deposits';

  private readonly logger = new Logger(SavingDepositCron.name);
  private running = false;

  constructor(
    private readonly assetsService: AssetsService,
    private readonly moneyEventsService: MoneyEventsService,
    @Inject(ASSETS_REPOSITORY)
    private readonly assetsRepository: AssetsRepository,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 01:15 VN — after midnight, so a deposit maturing "today" is settled on the
   * first run of the day it is actually due, and well clear of the 23:45
   * market-valuation job rather than competing with it for the pool.
   */
  @Cron('15 1 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async runDaily(): Promise<void> {
    if (process.env.SAVING_DEPOSIT_CRON_ENABLED === 'false') return;
    await this.run();
  }

  /** Separate from the scheduled method so it can be driven directly. */
  async run(): Promise<{
    households: number;
    credited: number;
    settled: number;
  }> {
    // Per-process guard; the advisory lock below covers other instances.
    if (this.running) {
      this.logger.warn('Saving-deposit pass already running — skipping tick');
      return { households: 0, credited: 0, settled: 0 };
    }
    this.running = true;

    try {
      const result = await withAdvisoryLock(
        this.prisma,
        SavingDepositCron.LOCK_NAME,
        () => this.processAll(),
      );
      if (!result) {
        this.logger.log(
          'Saving deposits: another instance holds the lock — skipping',
        );
        return { households: 0, credited: 0, settled: 0 };
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private async processAll(): Promise<{
    households: number;
    credited: number;
    settled: number;
  }> {
    const startedAt = Date.now();
    // Resolved once: a batch crossing midnight must not split across two dates.
    const asOf = todayInTimeZone();
    const householdIds =
      await this.assetsRepository.findHouseholdsWithActiveDeposits(
        asOf,
        this.batchLimit(),
      );

    if (householdIds.length === 0) {
      this.logger.log(`Saving deposits: nothing to do for ${asOf}`);
      return { households: 0, credited: 0, settled: 0 };
    }

    let credited = 0;
    let settled = 0;
    let failed = 0;
    for (const chunk of this.chunked(householdIds, this.concurrency())) {
      const results = await Promise.all(
        chunk.map(async (householdId) => {
          try {
            // Accrue first, then settle — see the class doc.
            const accrual =
              await this.moneyEventsService.accrueHouseholdInterest(
                householdId,
              );
            const settlement = await this.assetsService.settleMaturedDeposits(
              householdId,
              asOf,
            );
            return {
              credited: accrual.credited,
              settled: settlement.settled,
            };
          } catch (error) {
            // One household's failure must not abandon the rest of the batch.
            failed += 1;
            this.logger.error(
              `Saving deposits failed for household ${householdId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return { credited: 0, settled: 0 };
          }
        }),
      );
      for (const result of results) {
        credited += result.credited;
        settled += result.settled;
      }
    }

    this.logger.log(
      `Saving deposits ${asOf}: ${householdIds.length} household(s), ` +
        `${credited} interest payout(s), ${settled} settled, ${failed} failed, ` +
        `${Date.now() - startedAt}ms`,
    );
    return { households: householdIds.length, credited, settled };
  }

  private concurrency(): number {
    const raw = Number(process.env.SAVING_DEPOSIT_CONCURRENCY);
    return Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : DEFAULT_CONCURRENCY;
  }

  private batchLimit(): number {
    const raw = Number(process.env.SAVING_DEPOSIT_BATCH_LIMIT);
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

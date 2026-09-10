import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GOALS_REPOSITORY } from '../goals/repositories/goals.repository.interface';
import type {
  GoalsRepository,
  SettlementWrite,
} from '../goals/repositories/goals.repository.interface';
import { AssetsService } from '../assets/assets.service';
import { settleMonthlyContributions } from '../goals/domain/settle-contributions';
import { SnapshotsService } from './snapshots.service';
import { SNAPSHOTS_REPOSITORY } from './repositories/snapshots.repository.interface';
import type { SnapshotsRepository } from './repositories/snapshots.repository.interface';
import { todayInTimeZone } from '../../common/utils/clock';
import { withAdvisoryLock } from '../../common/utils/advisory-lock';
import { PrismaService } from '../../database/prisma/prisma.service';

/** Kept below the DB pool budget so the job never starves live requests. */
const CONCURRENCY = 3;

/**
 * How many missed months a household will catch up in one run. A gap longer
 * than this is a data problem, not a scheduling one, and closing years of
 * months against TODAY's balance would invent a history.
 */
const MAX_CATCH_UP_MONTHS = 12;

/**
 * Everything that happens to a household when a month ends, in one job.
 *
 * Two phases, and the ORDER between them is the reason they share a job rather
 * than sharing a cron expression:
 *
 *  1. **Snapshot** — freeze the whole picture, `allocated_amount` included.
 *  2. **Settle** — close the contribution ledgers, REWRITING those amounts.
 *
 * Run the other way round and the snapshot records ledgers that already carry
 * the month's contribution, so every frozen goal figure is one month ahead of
 * the picture it claims to be. As two crons at the same minute that ordering
 * would be a scheduling coincidence; here it is a guarantee.
 *
 * See memory/goals.md and memory/snapshots-and-networth.md.
 */
@Injectable()
export class MonthEndCron {
  /** Cluster-wide lock name; see `withAdvisoryLock`. */
  private static readonly LOCK_NAME = 'households:month-end';

  private readonly logger = new Logger(MonthEndCron.name);
  private running = false;

  constructor(
    @Inject(GOALS_REPOSITORY)
    private readonly goalsRepository: GoalsRepository,
    private readonly assetsService: AssetsService,
    private readonly snapshotsService: SnapshotsService,
    @Inject(SNAPSHOTS_REPOSITORY)
    private readonly snapshotsRepository: SnapshotsRepository,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 00:20 VN on the 1st. Deliberately AFTER midnight rather than at 23:50 on the
   * last day: a month is only closed once it is actually over, and money moved
   * in the final ten minutes belongs to the month it moved in.
   */
  @Cron('20 0 1 * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async runMonthly(): Promise<void> {
    if (process.env.MONTH_END_CRON_ENABLED === 'false') return;
    await this.run();
  }

  async run(): Promise<void> {
    if (this.running) {
      this.logger.warn('settlement already running; skipping this tick');
      return;
    }
    this.running = true;
    try {
      await withAdvisoryLock(this.prisma, MonthEndCron.LOCK_NAME, () =>
        this.closeAllHouseholds(),
      );
    } finally {
      this.running = false;
    }
  }

  private async closeAllHouseholds(): Promise<void> {
    // Every household, not only those with goals: the snapshot half is the
    // whole financial picture. The settle half skips the ones with nothing to
    // close on its own.
    const householdIds = await this.snapshotsRepository.findAllHouseholdIds();
    if (householdIds.length === 0) return;

    let snapshots = 0;
    let settled = 0;
    let failed = 0;
    const queue = [...householdIds];
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, queue.length) },
      async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          try {
            // Phase 1, and it must finish before phase 2 touches the ledgers.
            if (await this.snapshotHousehold(id)) snapshots += 1;
            settled += await this.settleHousehold(id);
          } catch (error) {
            // One household's bad data must not stop the rest; it retries next
            // month, and the months it missed are caught up then.
            failed += 1;
            this.logger.error(
              `month-end failed household=${id}: ${String(error)}`,
            );
          }
        }
      },
    );
    await Promise.all(workers);
    this.logger.log(
      `month.end households=${householdIds.length} snapshots=${snapshots} shares=${settled} failed=${failed}`,
    );
  }

  /**
   * Freeze the household's picture before anything is rewritten.
   *
   * A failure here must NOT stop the settlement: a household whose forecast
   * cannot be built still deserves its ledgers closed, and a snapshot is a
   * record, not a precondition. Logged and stepped over.
   *
   * @returns whether a snapshot was actually taken.
   */
  private async snapshotHousehold(householdId: string): Promise<boolean> {
    try {
      await this.snapshotsService.createSnapshot(
        householdId,
        { note: 'Chốt cuối tháng' },
        null,
      );
      return true;
    } catch (error) {
      // Includes the deliberate 60s rate limit: somebody who took a snapshot
      // moments ago already has the picture this would have written.
      this.logger.warn(
        `month-end snapshot skipped household=${householdId}: ${String(error)}`,
      );
      return false;
    }
  }

  /** @returns how many shares were closed. */
  private async settleHousehold(householdId: string): Promise<number> {
    const months = await this.monthsToClose(householdId);
    if (months.length === 0) return 0;

    let written = 0;
    for (const month of months) {
      // Re-read between months: each close rewrites the ledgers the next one
      // opens from.
      const shares =
        await this.goalsRepository.findContributionSharesForSettlement(
          householdId,
        );
      if (shares.length === 0) break;

      const balances = await this.walletBalances(
        householdId,
        shares.map((share) => share.assetId),
      );
      const results = settleMonthlyContributions(shares, balances);
      const rows: SettlementWrite[] = results.map((result) => ({
        allocationId: result.allocationId,
        goalId: result.goalId,
        assetId: result.assetId,
        opening: round2(result.opening),
        target: round2(result.target),
        closing: round2(result.closing),
        actual: round2(result.actual),
        walletBalance: round2(balances.get(result.assetId) ?? 0),
        shortOnWallet: result.shortOnWallet,
        needsShareDecision: result.needsShareDecision,
      }));

      written += await this.prisma.runInTransaction(() =>
        this.goalsRepository.insertSettlementsAndAdvanceLedgers(
          householdId,
          month,
          rows,
        ),
      );
    }
    return written;
  }

  /**
   * Which months still need closing, oldest first.
   *
   * Only months that have ENDED: the current one is still running and has no
   * closing balance yet. A household that has never been settled closes just the
   * month that has most recently ended — there is no earlier balance to close
   * older months against, and back-dating them to today's figure would invent a
   * history the household never had.
   */
  private async monthsToClose(householdId: string): Promise<string[]> {
    const today = todayInTimeZone();
    const lastEnded = previousMonth(today.slice(0, 7));
    const lastSettled =
      await this.goalsRepository.findLastSettledMonth(householdId);
    if (!lastSettled) return [lastEnded];

    const months: string[] = [];
    for (
      let month = nextMonth(lastSettled);
      month <= lastEnded && months.length < MAX_CATCH_UP_MONTHS;
      month = nextMonth(month)
    ) {
      months.push(month);
    }
    return months;
  }

  private async walletBalances(
    householdId: string,
    assetIds: string[],
  ): Promise<Map<string, number>> {
    // The valuation engine, not the raw row: a wallet's figure has to be the
    // same one every other goal surface reads.
    const assets = await this.assetsService.getActiveAssetRecords(householdId);
    const wanted = new Set(assetIds);
    return new Map(
      assets
        .filter((asset) => wanted.has(asset.id))
        .map((asset) => [asset.id, asset.currentValue ?? 0]),
    );
  }
}

/** VND is stored to 2dp; the waterfall's weighted splits are not. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function nextMonth(month: string): string {
  const [year, index] = month.split('-').map(Number);
  return index === 12
    ? `${year + 1}-01`
    : `${year}-${String(index + 1).padStart(2, '0')}`;
}

function previousMonth(month: string): string {
  const [year, index] = month.split('-').map(Number);
  return index === 1
    ? `${year - 1}-12`
    : `${year}-${String(index - 1).padStart(2, '0')}`;
}

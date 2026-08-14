import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { todayInTimeZone } from '../../common/utils/clock';
import { computeFlexibleMoney } from '../forecast/domain/flexible-money';
import { runForecast } from '../forecast/domain/forecast';
import { ForecastService } from '../forecast/forecast.service';
import { AttentionService } from '../attention/attention.service';
import {
  SNAPSHOTS_REPOSITORY,
  type SnapshotsRepository,
} from './repositories/snapshots.repository.interface';

/**
 * How often a household may take a snapshot.
 *
 * Not a business rule — a double-tap guard. Two snapshots seconds apart are
 * never intentional, and each one writes a row per asset.
 */
const MIN_SECONDS_BETWEEN_SNAPSHOTS = 60;

/** Horizon frozen into a snapshot when the caller doesn't choose one. */
const DEFAULT_SNAPSHOT_HORIZON_DAYS = 30;

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    @Inject(SNAPSHOTS_REPOSITORY)
    private readonly snapshotsRepository: SnapshotsRepository,
    private readonly forecast: ForecastService,
    private readonly attention: AttentionService,
  ) {}

  async listSnapshots(householdId: string) {
    // Guard and query are independent — see the note in `goals.service.ts`.
    const [, items] = await Promise.all([
      this.snapshotsRepository.assertHousehold(householdId),
      this.snapshotsRepository.listSnapshots(householdId),
    ]);
    return { householdId, items, total: items.length };
  }

  async getSnapshot(householdId: string, snapshotId: string) {
    await this.snapshotsRepository.assertHousehold(householdId);
    const snapshot = await this.snapshotsRepository.getSnapshotById(
      householdId,
      snapshotId,
    );
    if (!snapshot) {
      throw new NotFoundException(`Snapshot "${snapshotId}" was not found`);
    }
    return snapshot;
  }

  /**
   * Take a snapshot (spec §26).
   *
   * **A snapshot is append-only and never silently changes.** That is the whole
   * point of it, and it is exactly what the retired auto-hooks got wrong: they
   * upserted "today's row" after every asset/debt/money-event write, so a
   * snapshot kept moving after it was taken — and re-read `total_debt` live, so
   * an unrelated debt edit could rewrite yesterday's picture.
   *
   * The shape of this method is load-bearing. Steps 1–6 (valuing assets,
   * running the forecast, totalling debt, counting attention) all run OUTSIDE
   * the transaction; the transaction is three statements. An interactive
   * transaction holds one connection open on the direct client, and doing the
   * reads inside it is how the old path used to die with "Transaction not
   * found" on a slow household.
   */
  async createSnapshot(
    householdId: string,
    payload: { note?: string; horizonDays?: number } = {},
    userId?: string | null,
  ) {
    await this.snapshotsRepository.assertHousehold(householdId);

    // 1. Rate limit. A snapshot writes a row per asset, and two taken seconds
    //    apart are always a double-tap, never a decision.
    const lastCreatedAt =
      await this.snapshotsRepository.getLastSnapshotCreatedAt(householdId);
    if (lastCreatedAt) {
      const secondsSince = (Date.now() - lastCreatedAt.getTime()) / 1000;
      if (secondsSince < MIN_SECONDS_BETWEEN_SNAPSHOTS) {
        throw new ConflictException(
          `A snapshot was taken ${Math.round(secondsSince)}s ago. Wait ${
            MIN_SECONDS_BETWEEN_SNAPSHOTS - Math.round(secondsSince)
          }s.`,
        );
      }
    }

    const asOfDate = todayInTimeZone();
    const horizonDays = this.forecast.parseHorizon(
      payload.horizonDays ?? DEFAULT_SNAPSHOT_HORIZON_DAYS,
    );

    // 2–5. Everything expensive, concurrently, and all outside the transaction.
    const [lines, totalDebt, forecastInput, attentionCount] = await Promise.all(
      [
        this.snapshotsRepository.getClassifiedAssetLines(householdId, asOfDate),
        this.snapshotsRepository.getOutstandingDebtTotal(householdId),
        this.forecast.loadInput(householdId, horizonDays, asOfDate),
        // Stored items ONLY. A derived count isn't reproducible — it depends on a
        // forecast that will have moved by the time anyone reads this back, so
        // freezing it would put a number in the row that nothing can ever
        // recompute or verify.
        this.attention.countOpenStoredItems(householdId),
      ],
    );

    const forecast = runForecast(forecastInput);
    const flexible = computeFlexibleMoney(forecast);

    // 6. Totals by liquidity, from the SAME lines that get frozen — so the
    //    header figure and the per-asset breakdown can never disagree.
    const totals = { usable_now: 0, not_immediately_usable: 0, long_term: 0 };
    for (const line of lines) {
      if (line.liquidity in totals) {
        totals[line.liquidity as keyof typeof totals] += line.value;
      }
    }

    const id = this.snapshotsRepository.createId('snapshot');

    // 7. The write: three statements, one transaction.
    await this.snapshotsRepository.createSnapshot({
      id,
      householdId,
      snapshotDate: asOfDate,
      totalLiquid: totals.usable_now,
      totalSavings: totals.not_immediately_usable,
      totalLongTermAssets: totals.long_term,
      totalDebt,
      upcomingDueAmount: forecast.totals.requiredOutgoingAmount,
      attentionCount,
      protectedReserveAmount: forecast.protectedReserveAmount,
      forecastHorizonDays: horizonDays,
      upcomingIncomeAmount: forecast.totals.upcomingIncomeAmount,
      upcomingOutgoingAmount: forecast.totals.upcomingOutgoingAmount,
      // Frozen as-is. Negative is the signal, not an error to sanitise (§10).
      lowestProjectedBalance: forecast.lowestProjectedBalance,
      flexibleMoney: flexible.flexibleMoneyToday,
      note: payload.note?.trim() || null,
      createdById: userId ?? null,
      lines,
    });

    this.logger.log(
      `snapshot.created household=${householdId} lines=${lines.length} horizon=${horizonDays}`,
    );

    // 8. Read it back so the caller gets exactly what was stored — including
    //    the derived financial state — rather than a hand-built echo that could
    //    drift from the row.
    return this.getSnapshot(householdId, id);
  }

  // The auto-snapshot hooks (onAssetChanged / onAssetRemoved /
  // onHouseholdChanged) were REMOVED in the v3.1 alignment — see the comment on
  // `createSnapshot` for what they did wrong. Snapshots are now taken
  // deliberately, and the live dashboard never read them anyway: it computes
  // net worth on the fly.
}

import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  SNAPSHOTS_REPOSITORY,
  type SnapshotsRepository,
} from './repositories/snapshots.repository.interface';

// Default household timezone until households carry their own. "Today" for the
// per-day snapshot is computed in this zone so the day boundary matches how a
// Vietnamese-first user perceives it (a change at 1am should land on that date,
// not the previous UTC day).
const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    @Inject(SNAPSHOTS_REPOSITORY)
    private readonly snapshotsRepository: SnapshotsRepository,
    private readonly prisma: PrismaService,
  ) {}

  async listSnapshots(householdId: string) {
    await this.snapshotsRepository.assertHousehold(householdId);
    const items = await this.snapshotsRepository.listSnapshots(householdId);
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

  // --- Auto-snapshot hooks ---------------------------------------------------
  //
  // Each hook upserts TODAY's snapshot for the household, then recomputes its
  // totals from the current child rows. They are called AFTER the triggering
  // write's transaction has committed. Two safety rails:
  //   1. `isInTransaction()` guard — if a service calls another service's write
  //      inside its own transaction (e.g. createDebt → createMoneyEvent), the
  //      inner hook skips; the outermost caller fires the snapshot once.
  //   2. try/catch — a snapshot failure must never break the primary operation
  //      (already committed) nor surface an error; it is logged and swallowed.

  /** Asset created/updated/sold → upsert its line (or remove it if no longer active). */
  async onAssetChanged(householdId: string, assetId: string): Promise<void> {
    if (this.prisma.isInTransaction()) return;
    try {
      // No transaction: every step is an idempotent upsert/recompute, so a
      // partial failure is self-healing on the next write. Skipping the tx
      // avoids an open+commit round-trip on the session pooler and lets these
      // single-statement queries run on the faster transaction-mode pooler.
      const snapshotId = await this.snapshotsRepository.ensureTodaySnapshot(
        householdId,
        this.today(),
      );
      const line = await this.snapshotsRepository.getActiveAssetLine(
        householdId,
        assetId,
      );
      if (line) {
        await this.snapshotsRepository.upsertAssetLine(
          snapshotId,
          householdId,
          line,
        );
      } else {
        await this.snapshotsRepository.removeAssetLine(snapshotId, assetId);
      }
      await this.snapshotsRepository.recomputeSnapshotTotals(
        snapshotId,
        householdId,
      );
    } catch (e) {
      this.logger.error(
        `auto-snapshot onAssetChanged failed (household=${householdId}, asset=${assetId})`,
        e as Error,
      );
    }
  }

  /** Asset deleted → drop its line from today's snapshot. */
  async onAssetRemoved(householdId: string, assetId: string): Promise<void> {
    if (this.prisma.isInTransaction()) return;
    try {
      const snapshotId = await this.snapshotsRepository.ensureTodaySnapshot(
        householdId,
        this.today(),
      );
      await this.snapshotsRepository.removeAssetLine(snapshotId, assetId);
      await this.snapshotsRepository.recomputeSnapshotTotals(
        snapshotId,
        householdId,
      );
    } catch (e) {
      this.logger.error(
        `auto-snapshot onAssetRemoved failed (household=${householdId}, asset=${assetId})`,
        e as Error,
      );
    }
  }

  /** Household-level change (debt, non-asset money event) → recompute totals only. */
  async onHouseholdChanged(householdId: string): Promise<void> {
    if (this.prisma.isInTransaction()) return;
    try {
      const snapshotId = await this.snapshotsRepository.ensureTodaySnapshot(
        householdId,
        this.today(),
      );
      await this.snapshotsRepository.recomputeSnapshotTotals(
        snapshotId,
        householdId,
      );
    } catch (e) {
      this.logger.error(
        `auto-snapshot onHouseholdChanged failed (household=${householdId})`,
        e as Error,
      );
    }
  }

  /** Today's date (YYYY-MM-DD) in the household timezone. */
  private today(): string {
    // en-CA formats as YYYY-MM-DD; the timeZone option shifts the day boundary.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}

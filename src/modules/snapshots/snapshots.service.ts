import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AS_OF } from '../../common/seed/money-space.seed';
import { computeLiquidityTotals } from '../../common/utils/money-space.utils';
import { AssetsService } from '../assets/assets.service';
import type { CreateSnapshotDto } from './dto/create-snapshot.dto';
import {
  SNAPSHOTS_REPOSITORY,
  type SnapshotAssetValueInput,
  type SnapshotsRepository,
} from './repositories/snapshots.repository.interface';

@Injectable()
export class SnapshotsService {
  constructor(
    @Inject(SNAPSHOTS_REPOSITORY)
    private readonly snapshotsRepository: SnapshotsRepository,
    private readonly assetsService: AssetsService,
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

  /**
   * Freeze the household's net worth at a point in time (spec §26). Reads run
   * OUTSIDE the write transaction (keeps it short); only the snapshot row +
   * per-asset line items (one bulk insert) + audit log run inside it.
   */
  async createSnapshot(householdId: string, dto: CreateSnapshotDto) {
    await this.snapshotsRepository.assertHousehold(householdId);

    // 1. Assemble inputs (reuses the SAME valuation engine as the live
    //    dashboard, so snapshot totals can't diverge from the live figures).
    const [assets, totalDebt, upcomingDueAmount, attentionCount] =
      await Promise.all([
        this.assetsService.getActiveAssetRecords(householdId),
        this.snapshotsRepository.getOutstandingDebtTotal(householdId),
        this.snapshotsRepository.getUpcomingDueTotal(householdId),
        this.snapshotsRepository.getOpenAttentionCount(householdId),
      ]);

    // 2. Per-asset frozen line items, each referencing the asset's current
    //    valuation (lineage back-pointer) when one exists.
    const assetValues: SnapshotAssetValueInput[] = [];
    for (const asset of assets) {
      const valuation = await this.assetsService.getCurrentValuation(asset.id);
      assetValues.push({
        id: this.snapshotsRepository.createId('snapshot-value'),
        assetId: asset.id,
        assetName: asset.name,
        assetType: asset.type,
        liquidity: asset.liquidity,
        value: asset.currentValue,
        currency: asset.currency,
        valuationId: valuation?.id,
        valuationMethod: valuation?.method,
        valuationDate: valuation?.valuationDate,
        visibilityLevel: 'detail',
      });
    }

    // 3. Totals via the shared engine.
    const totals = computeLiquidityTotals(assets);

    const snapshotId = this.snapshotsRepository.createId('snapshot');
    await this.snapshotsRepository.createSnapshot({
      id: snapshotId,
      householdId,
      snapshotDate: dto.snapshotDate ?? AS_OF,
      totalLiquid: totals.usable_now,
      totalSavings: totals.not_immediately_usable,
      totalLongTermAssets: totals.long_term,
      totalDebt,
      upcomingDueAmount,
      attentionCount,
      note: dto.note,
      assetValues,
    });

    // status/sourceMode are derived on read.
    return this.getSnapshot(householdId, snapshotId);
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mapHousehold } from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import {
  deriveSnapshotSourceMode,
  deriveSnapshotStatus,
} from '../../../common/utils/money-space.utils';
import { Household } from '../../households/entities/household.entity';
import { SnapshotDetail } from '../entities/snapshot-detail.entity';
import {
  SnapshotWriteInput,
  SnapshotsRepository,
} from './snapshots.repository.interface';

@Injectable()
export class PrismaSnapshotsRepository
  extends PrismaRepository
  implements SnapshotsRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(_prefix: string): string {
    return randomUUID();
  }

  async assertHousehold(householdId: string): Promise<Household> {
    const household = await this.prisma.household.findFirst({
      where: { id: householdId, deletedAt: null },
    });
    if (!household) {
      throw new NotFoundException(`Household "${householdId}" was not found`);
    }
    return mapHousehold(household);
  }

  async getOutstandingDebtTotal(householdId: string): Promise<number> {
    const agg = await this.prisma.debt.aggregate({
      where: { householdId, deletedAt: null, status: 'active' },
      _sum: { outstandingAmount: true },
    });
    return Number(agg._sum.outstandingAmount ?? 0);
  }

  async getUpcomingDueTotal(householdId: string): Promise<number> {
    const agg = await this.prisma.upcomingPayment.aggregate({
      where: { householdId, deletedAt: null, status: 'unpaid' },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }

  async getOpenAttentionCount(householdId: string): Promise<number> {
    return this.prisma.attentionItem.count({
      where: { householdId, status: 'open' },
    });
  }

  async createSnapshot(input: SnapshotWriteInput): Promise<void> {
    // Snapshot row → per-asset line items (one bulk createMany) → audit log,
    // all in one transaction. `created_by` is resolved from the household owner
    // (no request user in the worker path), matching insertAsset/writeAuditLog.
    await this.runInTransaction(async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO snapshots
          (id, household_id, snapshot_date, total_liquid, total_savings,
           total_long_term_assets, total_debt, upcoming_due_amount,
           attention_count, note, created_by, created_at)
        SELECT
          ${input.id}::uuid,
          h.id,
          ${this.toDate(input.snapshotDate)}::date,
          ${input.totalLiquid}::numeric,
          ${input.totalSavings}::numeric,
          ${input.totalLongTermAssets}::numeric,
          ${input.totalDebt}::numeric,
          ${input.upcomingDueAmount}::numeric,
          ${input.attentionCount},
          ${input.note ?? null},
          h.created_by,
          now()
        FROM households h
        WHERE h.id = ${input.householdId}::uuid
          AND h.deleted_at IS NULL
      `;
      if (inserted === 0) {
        throw new NotFoundException(
          `Household "${input.householdId}" was not found`,
        );
      }

      if (input.assetValues.length > 0) {
        await tx.snapshotAssetValue.createMany({
          data: input.assetValues.map((line) => ({
            id: line.id,
            householdId: input.householdId,
            snapshotId: input.id,
            assetId: line.assetId,
            assetName: line.assetName,
            assetType: line.assetType as any,
            liquidity: line.liquidity as any,
            value: line.value,
            currency: line.currency,
            valuationId: line.valuationId ?? null,
            valuationMethod: (line.valuationMethod ?? null) as any,
            valuationDate: line.valuationDate
              ? this.toDate(line.valuationDate)
              : null,
            visibilityLevel: line.visibilityLevel as any,
          })),
        });
      }

      const metadata = JSON.stringify({
        totalLiquid: input.totalLiquid,
        totalSavings: input.totalSavings,
        totalLongTermAssets: input.totalLongTermAssets,
        totalDebt: input.totalDebt,
        assetCount: input.assetValues.length,
      });
      await tx.$executeRaw`
        INSERT INTO audit_logs
          (id, household_id, actor_id, action, entity_type, entity_id, metadata, created_at)
        SELECT
          ${randomUUID()}::uuid, h.id, h.created_by,
          'snapshot.created', 'snapshot', ${input.id}::uuid,
          ${metadata}::jsonb, now()
        FROM households h
        WHERE h.id = ${input.householdId}::uuid
          AND h.deleted_at IS NULL
      `;
    });
  }

  async listSnapshots(householdId: string): Promise<SnapshotDetail[]> {
    const rows = await this.prisma.snapshot.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { snapshotDate: 'desc' },
      include: { snapshotAssetValues: true },
    });
    return rows.map((row) => this.toDetail(row));
  }

  async getSnapshotById(
    householdId: string,
    snapshotId: string,
  ): Promise<SnapshotDetail | undefined> {
    const row = await this.prisma.snapshot.findFirst({
      where: { id: snapshotId, householdId, deletedAt: null },
      include: { snapshotAssetValues: true },
    });
    return row ? this.toDetail(row) : undefined;
  }

  private toDetail(row: any): SnapshotDetail {
    const items = (row.snapshotAssetValues ?? []).map((v: any) => ({
      id: v.id,
      assetId: v.assetId,
      assetName: v.assetName,
      assetType: v.assetType,
      liquidity: v.liquidity,
      value: Number(v.value),
      currency: v.currency,
      valuationId: v.valuationId ?? undefined,
      valuationMethod: v.valuationMethod ?? undefined,
      valuationDate: v.valuationDate
        ? new Date(v.valuationDate).toISOString().slice(0, 10)
        : undefined,
      visibilityLevel: v.visibilityLevel,
    }));

    const totalAssets =
      Number(row.totalLiquid) +
      Number(row.totalSavings) +
      Number(row.totalLongTermAssets);

    // status/sourceMode are DERIVED, not stored (columns dropped in PR3).
    const status = deriveSnapshotStatus({
      totalAssets,
      totalDebt: Number(row.totalDebt),
      totalLiquid: Number(row.totalLiquid),
      upcomingDueAmount: Number(row.upcomingDueAmount),
      attentionCount: row.attentionCount,
      assetCount: items.length,
    });
    const sourceMode = deriveSnapshotSourceMode(
      items.map((i: { valuationMethod?: string }) => i.valuationMethod),
    );

    return {
      id: row.id,
      householdId: row.householdId,
      snapshotDate: new Date(row.snapshotDate).toISOString().slice(0, 10),
      totalLiquid: Number(row.totalLiquid),
      totalSavings: Number(row.totalSavings),
      totalLongTermAssets: Number(row.totalLongTermAssets),
      totalDebt: Number(row.totalDebt),
      upcomingDueAmount: Number(row.upcomingDueAmount),
      attentionCount: row.attentionCount,
      status,
      sourceMode,
      note: row.note ?? undefined,
      createdAt: new Date(row.createdAt).toISOString(),
      items,
    };
  }
}

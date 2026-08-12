import { Injectable, NotFoundException } from '@nestjs/common';
import {
  mapHousehold,
  numberFromDb,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { uuidv7 } from '../../../common/utils/uuid';
import { Household } from '../../households/entities/household.entity';
import type { StoredAttentionItem } from '../entities/attention-item.entity';
import type {
  AttentionRepository,
  DismissalTombstone,
  InsertAttentionItemInput,
} from './attention.repository.interface';

@Injectable()
export class PrismaAttentionRepository
  extends PrismaRepository
  implements AttentionRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(_prefix: string): string {
    return uuidv7();
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

  async findOpenStoredItems(
    householdId: string,
  ): Promise<StoredAttentionItem[]> {
    const rows = await this.prisma.attentionItem.findMany({
      where: { householdId, status: { in: ['open', 'seen'] } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toEntity(row));
  }

  async findStoredItemById(
    householdId: string,
    itemId: string,
  ): Promise<StoredAttentionItem | undefined> {
    const row = await this.prisma.attentionItem.findFirst({
      where: { id: itemId, householdId },
    });
    return row ? this.toEntity(row) : undefined;
  }

  async findDismissals(householdId: string): Promise<DismissalTombstone[]> {
    // Served by `attention_items_household_id_rule_code_idx`. Selects only the
    // two matching keys — a dismissal is read on every attention request, so it
    // must not drag whole rows across.
    const rows = await this.prisma.attentionItem.findMany({
      where: { householdId, status: 'dismissed' },
      select: { ruleCode: true, relatedObjectId: true },
    });
    return rows
      .filter((row): row is { ruleCode: string; relatedObjectId: string | null } =>
        Boolean(row.ruleCode),
      )
      .map((row) => ({
        ruleCode: row.ruleCode as DismissalTombstone['ruleCode'],
        relatedObjectId: row.relatedObjectId ?? null,
      }));
  }

  async insertItem(input: InsertAttentionItemInput): Promise<void> {
    // Single statement that also proves the household is live: no row selected
    // → nothing inserted → 404, without a second round-trip.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO attention_items
        (id, household_id, title, reason, rule_code, level, status,
         amount, related_object_type, related_object_id, created_by,
         dismissed_at, dismissed_by)
      SELECT
        ${input.id}::uuid,
        h.id,
        ${input.title},
        ${input.reason ?? null},
        ${input.ruleCode},
        ${input.level ?? 'normal'}::"AttentionLevel",
        ${input.status ?? 'open'}::"AttentionItemStatus",
        ${input.amount ?? null}::numeric,
        ${input.relatedObjectType ?? null}::"RelatedObjectType",
        ${this.asUuid(input.relatedObjectId ?? null)}::uuid,
        ${this.asUuid(input.createdById ?? null)}::uuid,
        -- A row inserted directly with status dismissed IS a tombstone, so it
        -- carries its stamp from birth rather than needing a follow-up write.
        ${input.status === 'dismissed' ? new Date() : null}::timestamptz,
        ${input.status === 'dismissed' ? this.asUuid(input.createdById ?? null) : null}::uuid
      FROM households h
      WHERE h.id = ${input.householdId}::uuid
        AND h.deleted_at IS NULL
    `;

    if (inserted === 0) {
      throw new NotFoundException(
        `Household "${input.householdId}" was not found`,
      );
    }
  }

  async markSeen(itemId: string, userId: string | null): Promise<void> {
    await this.prisma.attentionItem.updateMany({
      // Only from `open`: re-seeing an already-resolved item must not reopen it.
      where: { id: itemId, status: 'open' },
      data: { status: 'seen', seenAt: new Date(), seenById: this.asUuid(userId) },
    });
  }

  async markResolved(itemId: string, userId: string | null): Promise<void> {
    await this.prisma.attentionItem.updateMany({
      where: { id: itemId },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedById: this.asUuid(userId),
      },
    });
  }

  async markDismissed(itemId: string, userId: string | null): Promise<void> {
    await this.prisma.attentionItem.updateMany({
      where: { id: itemId },
      data: {
        status: 'dismissed',
        dismissedAt: new Date(),
        dismissedById: this.asUuid(userId),
      },
    });
  }

  async countOpenStoredItems(householdId: string): Promise<number> {
    return this.prisma.attentionItem.count({
      where: { householdId, status: { in: ['open', 'seen'] } },
    });
  }

  private toEntity(row: Record<string, any>): StoredAttentionItem {
    return {
      id: row.id,
      householdId: row.householdId,
      title: row.title,
      reason: row.reason ?? null,
      ruleCode: row.ruleCode ?? null,
      level: row.level,
      status: row.status,
      amount: row.amount === null ? null : numberFromDb(row.amount),
      relatedObjectType: row.relatedObjectType ?? null,
      relatedObjectId: row.relatedObjectId ?? null,
      visibilityLevel: row.visibilityLevel,
      privacyOwnerMemberId: row.privacyOwnerMemberId ?? null,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}

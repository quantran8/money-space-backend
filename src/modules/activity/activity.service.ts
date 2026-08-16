import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';

/** One page of the journal. Cursor is the `occurredAt` of the last item seen. */
export interface ActivityQuery {
  limit?: string | number;
  before?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * The household journal — Nhật ký (§2.14, §14.10).
 *
 * Under this model the journal carries the weight that used to sit on
 * permissions: nobody is prevented from changing anything, so what makes a
 * change accountable is that the other person can see it happened. That makes
 * this a product surface, not an admin tool, and it is why it is ungated —
 * every member reads the same feed.
 *
 * The response is CODES plus structured metadata. The client builds every
 * sentence, exactly as it does for forecast assumptions.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async listActivity(householdId: string, query: ActivityQuery = {}) {
    const limit = this.parseLimit(query.limit);
    const before = query.before ? new Date(query.before) : undefined;

    // Ask for one extra row to learn whether another page exists without a
    // second COUNT query.
    const rows = await this.prisma.client().auditLog.findMany({
      where: {
        householdId,
        ...(before && !Number.isNaN(before.getTime())
          ? { createdAt: { lt: before } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: {
        actor: { select: { id: true, fullName: true, displayName: true } },
      },
    });

    const page = rows.slice(0, limit);
    const items = page.map((row) => this.toEntry(row));

    return {
      householdId,
      items,
      nextCursor:
        rows.length > limit
          ? page[page.length - 1].createdAt.toISOString()
          : null,
    };
  }

  private parseLimit(raw: ActivityQuery['limit']): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
    return Math.min(Math.trunc(parsed), MAX_LIMIT);
  }

  private toEntry(row: {
    id: string;
    createdAt: Date;
    action: string;
    entityType: string;
    entityId: string | null;
    metadata: unknown;
    actor: {
      id: string;
      fullName: string | null;
      displayName: string | null;
    } | null;
  }) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const impact = (metadata.impact ?? null) as {
      metric: string;
      delta: number;
    } | null;

    return {
      id: row.id,
      occurredAt: row.createdAt.toISOString(),
      actor: row.actor
        ? {
            id: row.actor.id,
            name: row.actor.displayName ?? row.actor.fullName ?? null,
          }
        : null,
      action: row.action,
      objectType: row.entityType,
      objectId: row.entityId,
      objectName: (metadata.objectName as string) ?? null,
      amount: (metadata.amount as number) ?? null,
      impact,
    };
  }
}

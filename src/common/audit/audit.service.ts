import { Injectable } from '@nestjs/common';
import { uuidv7 } from '../utils/uuid';
import { PrismaService } from '../../database/prisma/prisma.service';
import type { AuditRecordInput } from './audit.types';

/**
 * The single way anything gets into the journal.
 *
 * Before this there were four ad-hoc writers using three different mechanisms —
 * a raw `$executeRaw` INSERT in the debts repository and three
 * `tx.auditLog.create` calls — which is how the actor attribution in one of
 * them drifted without anyone noticing.
 *
 * Writes join the caller's transaction automatically: `PrismaService.client()`
 * resolves to the active transaction client via `AsyncLocalStorage`, so a call
 * site inside `runInTransaction` gets the entry committed or rolled back with
 * the change it describes. A journal entry for a write that did not happen
 * would be worse than no entry at all.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prismaService: PrismaService) {}

  async record(householdId: string, input: AuditRecordInput): Promise<void> {
    const metadata: Record<string, unknown> = { ...(input.details ?? {}) };
    if (input.impact) {
      metadata.impact = input.impact;
    }

    await this.prismaService.client().auditLog.create({
      data: {
        id: uuidv7(),
        householdId,
        // NULL is meaningful and correct for system flows. Attributing a
        // background write to a plausible-looking person is worse than
        // admitting nobody did it — once these rows are user-visible, a wrong
        // name is a lie the household can read.
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        metadata,
      } as never,
    });
  }
}

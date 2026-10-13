import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CacheInvalidator } from '../../../common/cache/cache-invalidator.service';
import { isUniqueViolation } from '../../../common/repositories/prisma-errors';
import { MoneyEventsService } from '../../money-events/money-events.service';
import { CashflowSettlementService } from '../../cashflow-events/services/cashflow-settlement.service';
import type { BankEventStatus } from '../entities/bank-sync.entity';
import { moneyEventNote } from '../domain/money-event-note';
import { vnIsoDate } from '../domain/vn-time';
import { isPostableWallet } from '../domain/wallet';
import { BANK_SYNC_REPOSITORY } from '../repositories/bank-sync.repository.interface';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';

export { moneyEventNote };

const POSTABLE: ReadonlySet<BankEventStatus> = new Set([
  'RECEIVED',
  'UNMAPPED',
  'REVIEW',
  'FAILED',
  'DUPLICATE',
]);

export type PostOutcome = 'posted' | 'already_posted';

/** What to settle with the posted money event. See memory/cashflow-settlement.md. */
export type PostSettle =
  | {
      kind: 'link';
      cashflowEventId: string;
      via: 'manual_link' | 'auto_note';
      matchRuleId?: string | null;
    }
  | { kind: 'replace_manual'; cashflowEventId: string };

@Injectable()
export class BankPostingService {
  constructor(
    @Inject(BANK_SYNC_REPOSITORY)
    private readonly repo: BankSyncRepository,
    private readonly moneyEvents: MoneyEventsService,
    private readonly cache: CacheInvalidator,
    private readonly settlement: CashflowSettlementService,
  ) {}

  /**
   * Event → money event, exactly once. The row lock serialises callers; the
   * unique `notification_event_id` is the backstop. See memory/bank-sync.md.
   */
  async post(
    householdId: string,
    eventId: string,
    actorId: string,
    assetId?: string,
    settle?: PostSettle,
  ): Promise<PostOutcome> {
    try {
      return await this.cache.runInTransactionAndInvalidate(
        householdId,
        async () => {
          const event = await this.repo.lockEvent(eventId);
          if (!event || event.householdId !== householdId) {
            throw new NotFoundException('Bank event not found.');
          }
          if (event.moneyEventId || event.status === 'PROCESSED') {
            return 'already_posted' as const;
          }
          if (!POSTABLE.has(event.status)) {
            throw new ConflictException(`Bank event is ${event.status}.`);
          }
          const targetId = assetId ?? event.matchedAssetId;
          if (!targetId || event.amountMinor === null || !event.direction) {
            throw new BadRequestException(
              'Bank event has no wallet or amount to post.',
            );
          }
          const wallet = await this.repo.findWallet(householdId, targetId);
          if (!isPostableWallet(wallet)) {
            throw new BadRequestException(
              'Target asset is not an active wallet.',
            );
          }

          const inflow = event.direction === 'IN';
          const categoryId = await this.moneyEvents.systemCategoryId(
            householdId,
            inflow ? 'income' : 'other',
          );
          const at =
            event.transactionAt ?? event.notificationAt ?? event.receivedAt;
          const created = await this.moneyEvents.createMoneyEvent(
            householdId,
            {
              amount: event.amountMinor,
              isoDate: vnIsoDate(at),
              type: inflow ? 'income' : 'expense',
              direction: inflow ? 'inflow' : 'outflow',
              categoryId,
              toAssetId: inflow ? targetId : undefined,
              fromAssetId: inflow ? undefined : targetId,
              note: moneyEventNote(event.providerCode, event.description),
            },
            {
              actorId,
              origin: 'bank_notification',
              notificationEventId: event.id,
            },
          );
          await this.repo.updateEvent(event.id, {
            status: 'PROCESSED',
            statusReason: null,
            matchedAssetId: targetId,
            processedAt: new Date(),
            processedById: actorId,
          });
          if (settle?.kind === 'link') {
            await this.settlement.settleExisting(
              householdId,
              settle.cashflowEventId,
              created.id,
              settle.via,
              actorId,
              settle.matchRuleId ?? null,
            );
          } else if (settle?.kind === 'replace_manual') {
            await this.settlement.replaceManualWithBank(
              householdId,
              settle.cashflowEventId,
              created.id,
              actorId,
            );
          }
          return 'posted' as const;
        },
        { timeout: 30000, maxWait: 10000 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) return 'already_posted';
      throw error;
    }
  }
}

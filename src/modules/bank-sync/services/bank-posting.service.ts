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
import type { BankEventStatus } from '../entities/bank-sync.entity';
import { vnIsoDate } from '../domain/vn-time';
import { isPostableWallet } from '../domain/wallet';
import { BANK_SYNC_REPOSITORY } from '../repositories/bank-sync.repository.interface';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';

const POSTABLE: ReadonlySet<BankEventStatus> = new Set([
  'RECEIVED',
  'UNMAPPED',
  'REVIEW',
  'FAILED',
  'DUPLICATE',
]);

export type PostOutcome = 'posted' | 'already_posted';

@Injectable()
export class BankPostingService {
  constructor(
    @Inject(BANK_SYNC_REPOSITORY)
    private readonly repo: BankSyncRepository,
    private readonly moneyEvents: MoneyEventsService,
    private readonly cache: CacheInvalidator,
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
          await this.moneyEvents.createMoneyEvent(
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

/** Money-event note from the stored bank-event description. See memory/bank-sync.md. */
export function moneyEventNote(
  providerCode: string | null,
  description: string | null,
): string {
  const text = (description ?? '').trim();
  if (providerCode === 'TECHCOMBANK') {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    return (lines.at(-1) ?? '')
      .replace(/[.\s]*M[aã]\s+tham\s+chi[eế]u\b.*$/iu, '')
      .trim();
  }
  if (providerCode === 'VCB') {
    // Content sits between `Ref <code>.` and the `FT…` trace string.
    const content = /\bRef\s+[^\s.]+\.?\s*([\s\S]*)$/u.exec(text)?.[1];
    if (content === undefined) return text;
    return content.replace(/\s*\bFT\d{6,}[\s\S]*$/u, '').trim();
  }
  return text;
}

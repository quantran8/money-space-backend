import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CacheInvalidator } from '../../../common/cache/cache-invalidator.service';
import { isUniqueViolation } from '../../../common/repositories/prisma-errors';
import { AssetsService } from '../../assets/assets.service';
import { MoneyEventsService } from '../../money-events/money-events.service';
import { CashflowSettlementService } from '../../cashflow-events/services/cashflow-settlement.service';
import type {
  BankEventStatus,
  BankNotificationEvent,
} from '../entities/bank-sync.entity';
import { moneyEventNote } from '../domain/money-event-note';
import { vnIsoDate } from '../domain/vn-time';
import { toWalletDrift } from '../domain/wallet-drift';
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
    private readonly assets: AssetsService,
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
          const { event, peer } = await this.lockWithPeer(householdId, eventId);
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
          const transferWallet = await this.postTransfer(
            householdId,
            event,
            peer,
            targetId,
            actorId,
            settle,
          );
          if (transferWallet) {
            await this.syncReportedBalances(householdId, [
              targetId,
              transferWallet,
            ]);
            return 'posted' as const;
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
          await this.markProcessed(event.id, targetId, actorId);
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
          await this.syncReportedBalances(householdId, [targetId]);
          return 'posted' as const;
        },
        { timeout: 30000, maxWait: 10000 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) return 'already_posted';
      throw error;
    }
  }

  /** The bank's reported balance always wins. See memory/bank-sync.md (Số dư). */
  private async syncReportedBalances(householdId: string, assetIds: string[]) {
    const observations =
      await this.repo.findLatestBalanceObservations(householdId);
    for (const obs of observations) {
      if (!assetIds.includes(obs.assetId)) continue;
      const drift = toWalletDrift(obs);
      if (!drift || drift.drift === 0) continue;
      await this.assets.syncWalletBalance(
        householdId,
        obs.assetId,
        drift.suggestedValue,
      );
    }
  }

  /** Locks the event and its transfer leg in id order. */
  private async lockWithPeer(householdId: string, eventId: string) {
    const head = await this.repo.findEvent(householdId, eventId);
    if (!head) throw new NotFoundException('Bank event not found.');
    const peerId = head.transferPeerEventId;
    const locked = new Map<string, BankNotificationEvent | null>();
    for (const id of [eventId, peerId].filter(isString).sort()) {
      locked.set(id, await this.repo.lockEvent(id));
    }
    const event = locked.get(eventId);
    if (!event || event.householdId !== householdId) {
      throw new NotFoundException('Bank event not found.');
    }
    if (event.transferPeerEventId !== peerId) {
      throw new ConflictException('Bank event was paired meanwhile; retry.');
    }
    return { event, peer: peerId ? (locked.get(peerId) ?? null) : null };
  }

  /** Own-account transfer, when the event is one leg. See memory/bank-sync.md. */
  private async postTransfer(
    householdId: string,
    event: BankNotificationEvent,
    leg: BankNotificationEvent | null,
    targetId: string,
    actorId: string,
    settle: PostSettle | undefined,
  ): Promise<string | null> {
    const inflow = event.direction === 'IN';
    // An ignored leg no longer vouches for the wallet on its side.
    const peer = leg?.status === 'IGNORED' ? null : leg;
    if (peer?.moneyEventId) {
      if (settle) throw new BadRequestException(TRANSFER_NO_SETTLE);
      await this.joinPostedLeg(
        householdId,
        peer.moneyEventId,
        inflow,
        targetId,
      );
      await this.markProcessed(event.id, targetId, actorId, TRANSFER_PAIRED);
      const posted = await this.moneyEvents.getMoneyEvent(
        householdId,
        peer.moneyEventId,
      );
      return (inflow ? posted.fromAssetId : posted.toAssetId) ?? null;
    }
    const otherId = peer
      ? peer.matchedAssetId
      : await this.counterpartWallet(householdId, event);
    if (!otherId || otherId === targetId) return null;
    if (!isPostableWallet(await this.repo.findWallet(householdId, otherId))) {
      if (peer)
        throw new BadRequestException('Transfer leg wallet is not active.');
      return null;
    }
    if (settle) throw new BadRequestException(TRANSFER_NO_SETTLE);
    const out = inflow ? peer : event;
    const note =
      (out && moneyEventNote(out.providerCode, out.description)) ||
      moneyEventNote(event.providerCode, event.description);
    await this.moneyEvents.createMoneyEvent(
      householdId,
      {
        amount: event.amountMinor as number,
        isoDate: vnIsoDate(transferAt(event, peer)),
        type: 'transfer',
        direction: 'neutral',
        categoryId: await this.moneyEvents.systemCategoryId(
          householdId,
          'transfer',
        ),
        fromAssetId: inflow ? otherId : targetId,
        toAssetId: inflow ? targetId : otherId,
        note,
      },
      { actorId, origin: 'bank_notification', notificationEventId: event.id },
    );
    await this.markProcessed(event.id, targetId, actorId);
    if (peer) {
      await this.markProcessed(peer.id, otherId, actorId, TRANSFER_PAIRED);
    }
    return otherId;
  }

  /** The other leg already posted: reuse its money event, turning it into a transfer if needed. */
  private async joinPostedLeg(
    householdId: string,
    moneyEventId: string,
    inflow: boolean,
    targetId: string,
  ) {
    const posted = await this.moneyEvents.getMoneyEvent(
      householdId,
      moneyEventId,
    );
    if (posted.type === 'transfer') {
      const ownSide = inflow ? posted.toAssetId : posted.fromAssetId;
      if (ownSide !== targetId) {
        throw new ConflictException('Transfer leg points at another wallet.');
      }
      return;
    }
    const otherSide = inflow ? posted.fromAssetId : posted.toAssetId;
    if (!otherSide || otherSide === targetId) {
      throw new ConflictException('Posted leg cannot become a transfer.');
    }
    await this.moneyEvents.updateMoneyEvent(householdId, moneyEventId, {
      type: 'transfer',
      direction: 'neutral',
      categoryId: await this.moneyEvents.systemCategoryId(
        householdId,
        'transfer',
      ),
      fromAssetId: inflow ? otherSide : targetId,
      toAssetId: inflow ? targetId : otherSide,
    });
  }

  private async counterpartWallet(
    householdId: string,
    event: BankNotificationEvent,
  ): Promise<string | null> {
    if (!event.counterpartSourceId) return null;
    const source = await this.repo.findSource(
      householdId,
      event.counterpartSourceId,
    );
    if (source?.status !== 'ACTIVE') return null;
    const links = await this.repo.findLinksAt(source.id, eventAt(event));
    return links.length === 1 ? links[0].assetId : null;
  }

  private async markProcessed(
    eventId: string,
    assetId: string,
    actorId: string,
    statusReason: string | null = null,
  ) {
    await this.repo.updateEvent(eventId, {
      status: 'PROCESSED',
      statusReason,
      matchedAssetId: assetId,
      processedAt: new Date(),
      processedById: actorId,
    });
  }
}

const TRANSFER_PAIRED = 'TRANSFER_PAIRED';
const TRANSFER_NO_SETTLE = 'A transfer cannot settle a cashflow event.';

function eventAt(event: BankNotificationEvent): Date {
  return event.transactionAt ?? event.notificationAt ?? event.receivedAt;
}

// Earliest leg; a content timestamp beats a delivery time.
function transferAt(
  event: BankNotificationEvent,
  peer: BankNotificationEvent | null,
): Date {
  const legs = peer ? [event, peer] : [event];
  const exact = legs.map((l) => l.transactionAt).filter((d): d is Date => !!d);
  const times = exact.length ? exact : legs.map(eventAt);
  return new Date(Math.min(...times.map((d) => d.getTime())));
}

function isString(value: string | null): value is string {
  return value !== null;
}

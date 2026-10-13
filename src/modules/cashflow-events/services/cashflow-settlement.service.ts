import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { CacheInvalidator } from '../../../common/cache/cache-invalidator.service';
import { isUniqueViolation } from '../../../common/repositories/prisma-errors';
import { addDaysIso, todayInTimeZone } from '../../../common/utils/clock';
import { MoneyEventsService } from '../../money-events/money-events.service';
import {
  advanceAfterSettlement,
  directionMatches,
  isLatestSettlement,
  revertSettlement,
  type SettledVia,
} from '../domain/settlement';
import type { CashflowEvent } from '../entities/cashflow-event.entity';
import { CASHFLOW_EVENTS_REPOSITORY } from '../repositories/cashflow-events.repository.interface';
import type { CashflowEventsRepository } from '../repositories/cashflow-events.repository.interface';
import {
  PrismaSettlementRepository,
  type SettlementMoneyEvent,
} from '../repositories/prisma-settlement.repository';

const CANDIDATE_DAYS = 45;

/** One settlement path for completion, manual link and note auto-match. See memory/cashflow-settlement.md. */
@Injectable()
export class CashflowSettlementService {
  constructor(
    @Inject(CASHFLOW_EVENTS_REPOSITORY)
    private readonly cashflowEvents: CashflowEventsRepository,
    private readonly repo: PrismaSettlementRepository,
    @Inject(forwardRef(() => MoneyEventsService))
    private readonly moneyEvents: MoneyEventsService,
    private readonly cache: CacheInvalidator,
  ) {}

  /** Link an already-recorded money event to the event's pending occurrence. */
  async settleExisting(
    householdId: string,
    eventId: string,
    moneyEventId: string,
    via: Exclude<SettledVia, 'manual_complete'>,
    actorId: string | null,
    matchRuleId: string | null = null,
  ) {
    try {
      return await this.cache.runInTransactionAndInvalidate(
        householdId,
        async () => {
          const event = await this.lockEvent(householdId, eventId);
          if (event.status === 'completed' || event.status === 'cancelled') {
            throw new ConflictException(
              `Cashflow event "${eventId}" is already ${event.status}`,
            );
          }
          const moneyEvent = await this.lockMoneyEvent(
            householdId,
            moneyEventId,
          );
          if (moneyEvent.cashflowEventId) {
            throw new ConflictException(
              `Money event "${moneyEventId}" is already linked to a cashflow event`,
            );
          }
          if (!directionMatches(event.direction, moneyEvent.direction)) {
            throw new BadRequestException(
              'Money event direction does not match the cashflow event',
            );
          }
          return this.attach(event, moneyEvent, via, actorId, matchRuleId);
        },
        { timeout: 30000, maxWait: 10000 },
      );
    } catch (error) {
      throw this.asConflict(error);
    }
  }

  /** Record the evidence for a money event the caller just created; joins its transaction. */
  async recordCompletion(
    event: CashflowEvent,
    moneyEventId: string,
    facts: { amount: number; assetId: string },
    actorId: string | null,
  ): Promise<CashflowEvent> {
    await this.repo.lockCashflowEvent(event.id);
    try {
      return await this.applySettlement(event, moneyEventId, {
        via: 'manual_complete',
        actorId,
        matchRuleId: null,
        amount: facts.amount,
        assetId: facts.assetId,
      });
    } catch (error) {
      throw this.asConflict(error);
    }
  }

  /** Detach bank evidence from its occurrence; the money event itself stays. */
  async unsettle(householdId: string, moneyEventId: string) {
    return this.cache.runInTransactionAndInvalidate(
      householdId,
      async () => {
        const moneyEvent = await this.lockMoneyEvent(householdId, moneyEventId);
        if (!moneyEvent.cashflowEventId || !moneyEvent.occurrenceDate) {
          throw new ConflictException(
            `Money event "${moneyEventId}" does not settle an occurrence`,
          );
        }
        // A completion's money event is undone by deleting it, not unlinking.
        if (moneyEvent.settledVia === 'manual_complete') {
          throw new ConflictException(
            'A manual completion is undone by deleting its money event',
          );
        }
        const event = await this.reopen(householdId, moneyEvent);
        await this.repo.clearSettlement(moneyEvent.id);
        await this.moneyEvents.relinkCashflow(householdId, moneyEvent.id, {
          cashflowEventId: null,
          debtId: null,
        });
        return { event };
      },
      { timeout: 30000, maxWait: 10000 },
    );
  }

  /** Called inside the money-event delete transaction. */
  async onMoneyEventDeleting(householdId: string, moneyEventId: string) {
    const moneyEvent = await this.repo.findMoneyEvent(
      householdId,
      moneyEventId,
    );
    if (!moneyEvent?.cashflowEventId || !moneyEvent.occurrenceDate) return;
    await this.reopen(householdId, moneyEvent);
    await this.repo.clearSettlement(moneyEvent.id);
  }

  /** S08: swap a manual completion for the bank money event of the same occurrence. */
  async replaceManualWithBank(
    householdId: string,
    eventId: string,
    bankMoneyEventId: string,
    actorId: string | null,
  ) {
    return this.cache.runInTransactionAndInvalidate(
      householdId,
      async () => {
        const event = await this.lockEvent(householdId, eventId);
        const [latest] = await this.repo.listSettlements(event.id);
        if (
          !latest ||
          latest.settledVia !== 'manual_complete' ||
          latest.notificationEventId
        ) {
          throw new ConflictException(
            'The latest occurrence was not completed manually',
          );
        }
        const bank = await this.lockMoneyEvent(householdId, bankMoneyEventId);
        if (bank.cashflowEventId || bank.origin !== 'bank_notification') {
          throw new ConflictException(
            `Money event "${bankMoneyEventId}" cannot replace a completion`,
          );
        }
        if (!directionMatches(event.direction, bank.direction)) {
          throw new BadRequestException(
            'Money event direction does not match the cashflow event',
          );
        }

        // Clear first so the delete hook leaves the event where it is.
        await this.repo.clearSettlement(latest.moneyEventId);
        await this.moneyEvents.deleteMoneyEvent(
          householdId,
          latest.moneyEventId,
        );
        await this.moneyEvents.relinkCashflow(householdId, bank.id, {
          cashflowEventId: event.id,
          debtId: event.debtId ?? null,
        });
        const now = new Date();
        await this.repo.markSettled(bank.id, {
          cashflowEventId: event.id,
          occurrenceDate: latest.occurrenceDate,
          settledVia: 'manual_link',
          settledById: actorId,
          settledAt: now,
          matchRuleId: null,
        });
        const next: CashflowEvent = {
          ...event,
          lastCompletedAt: now.toISOString(),
          lastCompletedById: actorId,
          lastCompletedAmount: bank.amount,
          lastCompletedAssetId: walletOf(bank),
        };
        await this.cashflowEvents.updateCashflowEvent(event.id, next);
        return { event: next };
      },
      { timeout: 30000, maxWait: 10000 },
    );
  }

  async linkCandidates(householdId: string, eventId: string, query?: string) {
    const event = await this.ensureEvent(householdId, eventId);
    const since = addDaysIso(todayInTimeZone(), -CANDIDATE_DAYS);
    return this.repo.findLinkCandidates(
      householdId,
      event.direction === 'incoming' ? 'inflow' : 'outflow',
      since,
      query,
    );
  }

  async listSettlements(householdId: string, eventId: string) {
    await this.ensureEvent(householdId, eventId);
    return this.repo.listSettlements(eventId);
  }

  private async attach(
    event: CashflowEvent,
    moneyEvent: SettlementMoneyEvent,
    via: SettledVia,
    actorId: string | null,
    matchRuleId: string | null,
  ) {
    await this.moneyEvents.relinkCashflow(event.householdId, moneyEvent.id, {
      cashflowEventId: event.id,
      debtId: event.debtId ?? null,
    });
    const next = await this.applySettlement(event, moneyEvent.id, {
      via,
      actorId,
      matchRuleId,
      amount: moneyEvent.amount,
      assetId: walletOf(moneyEvent),
    });
    return {
      event: next,
      advancedTo:
        next.expectedDate === event.expectedDate ? null : next.expectedDate,
    };
  }

  private async applySettlement(
    event: CashflowEvent,
    moneyEventId: string,
    opts: {
      via: SettledVia;
      actorId: string | null;
      matchRuleId: string | null;
      amount: number;
      assetId: string | null;
    },
  ): Promise<CashflowEvent> {
    const now = new Date();
    await this.repo.markSettled(moneyEventId, {
      cashflowEventId: event.id,
      occurrenceDate: event.expectedDate,
      settledVia: opts.via,
      settledById: opts.actorId,
      settledAt: now,
      matchRuleId: opts.matchRuleId,
    });
    const next = advanceAfterSettlement(event, {
      amount: opts.amount,
      assetId: opts.assetId,
      settledAt: now.toISOString(),
      settledById: opts.actorId,
    });
    await this.cashflowEvents.updateCashflowEvent(event.id, next);
    return next;
  }

  /** Only the newest settlement may be reopened. */
  private async reopen(householdId: string, moneyEvent: SettlementMoneyEvent) {
    const event = await this.lockEvent(
      householdId,
      moneyEvent.cashflowEventId!,
    );
    const settlements = await this.repo.listSettlements(event.id);
    if (!isLatestSettlement(settlements, moneyEvent.id)) {
      throw new ConflictException(
        'Only the most recent settled occurrence can be reopened',
      );
    }
    const next = revertSettlement(
      event,
      moneyEvent.occurrenceDate!,
      settlements[1] ?? null,
    );
    await this.cashflowEvents.updateCashflowEvent(event.id, next);
    return next;
  }

  private async lockEvent(householdId: string, eventId: string) {
    await this.repo.lockCashflowEvent(eventId);
    return this.ensureEvent(householdId, eventId);
  }

  private async ensureEvent(householdId: string, eventId: string) {
    const event = await this.cashflowEvents.findCashflowEventById(
      householdId,
      eventId,
    );
    if (!event) {
      throw new NotFoundException(`Cashflow event "${eventId}" was not found`);
    }
    return event;
  }

  private async lockMoneyEvent(householdId: string, moneyEventId: string) {
    const moneyEvent = await this.repo.lockMoneyEvent(
      householdId,
      moneyEventId,
    );
    if (!moneyEvent) {
      throw new NotFoundException(
        `Money event "${moneyEventId}" was not found`,
      );
    }
    return moneyEvent;
  }

  private asConflict(error: unknown) {
    return isUniqueViolation(error)
      ? new ConflictException('This occurrence is already settled')
      : error;
  }
}

function walletOf(moneyEvent: SettlementMoneyEvent): string | null {
  return moneyEvent.direction === 'inflow'
    ? moneyEvent.toAssetId
    : moneyEvent.fromAssetId;
}

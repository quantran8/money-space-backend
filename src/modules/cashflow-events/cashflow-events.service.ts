import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { todayInTimeZone } from '../../common/utils/clock';
import { nextOccurrenceAfter } from '../../common/utils/recurrence';
import { MoneyEventsService } from '../money-events/money-events.service';
import {
  CashflowEvent,
  CashflowRequirement,
} from './entities/cashflow-event.entity';
import type { CreateCashflowEventDto } from './dto/create-cashflow-event.dto';
import type { UpdateCashflowEventDto } from './dto/update-cashflow-event.dto';
import type { CompleteCashflowEventDto } from './dto/complete-cashflow-event.dto';
import type { ListCashflowEventsQuery } from './dto/list-cashflow-events.query';
import { CASHFLOW_EVENTS_REPOSITORY } from './repositories/cashflow-events.repository.interface';
import type { CashflowEventsRepository } from './repositories/cashflow-events.repository.interface';

@Injectable()
export class CashflowEventsService {
  constructor(
    @Inject(CASHFLOW_EVENTS_REPOSITORY)
    private readonly cashflowEventsRepository: CashflowEventsRepository,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => MoneyEventsService))
    private readonly moneyEvents: MoneyEventsService,
  ) {}

  async listCashflowEvents(
    householdId: string,
    query?: ListCashflowEventsQuery,
  ) {
    await this.cashflowEventsRepository.assertHousehold(householdId);

    let limit: number | undefined;
    if (query?.limit) {
      const parsed = Number(query.limit);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
    }

    const items = await this.cashflowEventsRepository.findCashflowEventsPage(
      householdId,
      {
        direction: query?.direction,
        status: query?.status,
        requirement: query?.requirement,
        certainty: query?.certainty,
        from: query?.from,
        to: query?.to,
        limit,
      },
    );

    return { householdId, items, total: items.length };
  }

  async getCashflowEvent(householdId: string, eventId: string) {
    return this.ensureCashflowEvent(householdId, eventId);
  }

  async createCashflowEvent(
    householdId: string,
    payload: CreateCashflowEventDto,
  ) {
    const event = this.buildEvent(householdId, payload);
    await this.cashflowEventsRepository.insertCashflowEvent(event);
    return event;
  }

  /**
   * Bulk create for callers that generate many events at once — e.g. a debt's
   * repayment schedule. One round-trip, so it can't blow an interactive
   * transaction's timeout on a pooled connection.
   */
  async createCashflowEvents(
    householdId: string,
    payloads: CreateCashflowEventDto[],
  ) {
    const events = payloads.map((payload) =>
      this.buildEvent(householdId, payload),
    );
    await this.cashflowEventsRepository.insertCashflowEvents(events);
    return events;
  }

  async updateCashflowEvent(
    householdId: string,
    eventId: string,
    payload: UpdateCashflowEventDto,
  ) {
    const event = await this.ensureCashflowEvent(householdId, eventId);
    const direction = payload.direction ?? event.direction;
    const next: CashflowEvent = {
      ...event,
      ...payload,
      id: event.id,
      householdId: event.householdId,
      name: payload.name?.trim() ?? event.name,
      amount: payload.amount ?? event.amount,
      direction,
      expectedDate: payload.expectedDate ?? event.expectedDate,
      recurrence: payload.recurrence ?? event.recurrence,
      recurrenceEndDate:
        payload.recurrenceEndDate !== undefined
          ? payload.recurrenceEndDate
          : event.recurrenceEndDate,
      requirement: this.resolveRequirement(
        direction,
        payload.requirement ?? event.requirement ?? undefined,
      ),
      certainty: payload.certainty ?? event.certainty,
      visibilityLevel: payload.visibilityLevel ?? event.visibilityLevel,
      attentionLevel: payload.attentionLevel ?? event.attentionLevel,
      note: payload.note?.trim() ?? event.note,
    };

    this.assertValid(next);
    await this.cashflowEventsRepository.updateCashflowEvent(eventId, next);
    return next;
  }

  async deleteCashflowEvent(householdId: string, eventId: string) {
    await this.ensureCashflowEvent(householdId, eventId);
    // The soft-delete and the money-event unlink must land together.
    await this.prisma.runInTransaction(async () => {
      await this.cashflowEventsRepository.deleteCashflowEvent(eventId);
      await this.cashflowEventsRepository.unlinkCashflowEventFromMoneyEvents(
        eventId,
      );
    });
    return { deleted: true, eventId };
  }

  /**
   * Record that an expected movement actually happened (spec §18
   * "Completion logic").
   *
   * The two branches are the heart of the recurrence model:
   *
   * - **one-off** → `status = completed`, `expectedDate` untouched. The record
   *   is finished.
   * - **recurring** → `expectedDate` ADVANCES to the next occurrence and
   *   `status` stays `expected`. The record is a live series, not history; the
   *   history lives in the money event this creates.
   *
   * The advance uses the same `nextOccurrenceAfter` the forecast uses to expand
   * occurrences, so completing an event always lands exactly where the forecast
   * predicted.
   */
  async completeCashflowEvent(
    householdId: string,
    eventId: string,
    payload: CompleteCashflowEventDto = {},
  ) {
    const event = await this.ensureCashflowEvent(householdId, eventId);

    if (event.status === 'completed' || event.status === 'cancelled') {
      throw new ConflictException(
        `Cashflow event "${eventId}" is already ${event.status}`,
      );
    }

    const occurrenceDate = payload.occurrenceDate ?? event.expectedDate;
    // Idempotency guard. Without this a double-tap would create two money
    // events AND advance a monthly series two months — silently losing a month
    // from the forecast.
    if (event.lastCompletedAt && occurrenceDate < event.expectedDate) {
      throw new ConflictException(
        `The occurrence on ${occurrenceDate} was already completed`,
      );
    }

    const amount = payload.amount ?? event.amount;
    if (amount < 0) {
      throw new BadRequestException('amount cannot be negative');
    }

    const advancedTo =
      event.recurrence === 'once'
        ? null
        : nextOccurrenceAfter(event.expectedDate, event.recurrence);

    // Past the end of the series → the series is over, not still running.
    const seriesFinished =
      advancedTo !== null &&
      event.recurrenceEndDate != null &&
      advancedTo > event.recurrenceEndDate;

    const next: CashflowEvent = {
      ...event,
      status: advancedTo === null || seriesFinished ? 'completed' : 'expected',
      expectedDate:
        advancedTo !== null && !seriesFinished
          ? advancedTo
          : event.expectedDate,
      lastCompletedAt: new Date().toISOString(),
      lastCompletedAmount: amount,
      lastCompletedAssetId: payload.assetId ?? null,
    };

    const moneyEvent = await this.prisma.runInTransaction(
      async () => {
        // Go through MoneyEventsService rather than a raw insert so the wallet
        // debit/credit, valuation points and the goal mirror all fire.
        const created = await this.moneyEvents.createMoneyEvent(householdId, {
          description: event.name,
          type: event.direction === 'outgoing' ? 'payment_paid' : 'income',
          category: event.direction === 'outgoing' ? 'other' : 'income',
          amount,
          isoDate: occurrenceDate,
          fromAssetId:
            event.direction === 'outgoing'
              ? (payload.assetId ?? undefined)
              : undefined,
          toAssetId:
            event.direction === 'incoming'
              ? (payload.assetId ?? undefined)
              : undefined,
          cashflowEventId: event.id,
          debtId: event.debtId ?? undefined,
          financialGoalId: event.financialGoalId ?? undefined,
          note: payload.note,
        } as never);

        await this.cashflowEventsRepository.updateCashflowEvent(eventId, next);
        return created;
      },
      { timeout: 30000, maxWait: 10000 },
    );

    return {
      event: next,
      moneyEvent,
      advancedTo:
        next.expectedDate === event.expectedDate ? null : next.expectedDate,
    };
  }

  /** Move an expected event to a later date without recording money moving. */
  async postponeCashflowEvent(
    householdId: string,
    eventId: string,
    payload: { newExpectedDate: string; note?: string },
  ) {
    const event = await this.ensureCashflowEvent(householdId, eventId);
    if (!payload.newExpectedDate) {
      throw new BadRequestException('newExpectedDate is required');
    }
    const next: CashflowEvent = {
      ...event,
      expectedDate: payload.newExpectedDate,
      // Back to `expected` at the new date: `postponed` describes a date the
      // forecast should not trust, and we now have a date to trust again.
      status: 'expected',
      note: payload.note?.trim() ?? event.note,
    };
    this.assertValid(next);
    await this.cashflowEventsRepository.updateCashflowEvent(eventId, next);
    return next;
  }

  async cancelCashflowEvent(
    householdId: string,
    eventId: string,
    payload: { note?: string } = {},
  ) {
    const event = await this.ensureCashflowEvent(householdId, eventId);
    const next: CashflowEvent = {
      ...event,
      status: 'cancelled',
      note: payload.note?.trim() ?? event.note,
    };
    await this.cashflowEventsRepository.updateCashflowEvent(eventId, next);
    return next;
  }

  /**
   * Effective-from-now repayment-amount change for a debt. Passthrough so
   * `DebtsService` (which injects this service, not the repo) can reach it
   * inside its own transaction. See memory/debts.md.
   */
  async updateOpenCashflowEventAmounts(
    householdId: string,
    debtId: string,
    fromDate: string,
    newAmount: number,
  ) {
    await this.cashflowEventsRepository.updateOpenCashflowEventAmountsByDebt(
      householdId,
      debtId,
      fromDate,
      newAmount,
    );
  }

  async deleteOpenCashflowEventsByDebt(
    householdId: string,
    debtId: string,
    fromDate?: string,
  ) {
    await this.cashflowEventsRepository.deleteOpenCashflowEventsByDebt(
      householdId,
      debtId,
      fromDate,
    );
  }

  // --- internals -----------------------------------------------------------

  private buildEvent(
    householdId: string,
    payload: CreateCashflowEventDto,
  ): CashflowEvent {
    const event: CashflowEvent = {
      id: this.cashflowEventsRepository.createId('cashflow-event'),
      householdId,
      name: payload.name?.trim() ?? '',
      amount: payload.amount,
      direction: payload.direction,
      expectedDate: payload.expectedDate,
      recurrence: payload.recurrence ?? 'once',
      recurrenceEndDate: payload.recurrenceEndDate ?? null,
      requirement: this.resolveRequirement(
        payload.direction,
        payload.requirement,
      ),
      certainty: payload.certainty ?? 'confirmed',
      status: 'expected',
      attentionLevel: payload.attentionLevel ?? 'normal',
      visibilityLevel: payload.visibilityLevel ?? 'detail',
      ownerMemberId: payload.ownerMemberId ?? null,
      debtId: payload.debtId ?? null,
      financialGoalId: payload.financialGoalId ?? null,
      plannedAssetId: payload.plannedAssetId ?? null,
      note: payload.note?.trim() ?? '',
      lastCompletedAt: null,
      lastCompletedById: null,
      lastCompletedAmount: null,
      lastCompletedAssetId: null,
    };

    this.assertValid(event);
    return event;
  }

  /**
   * §18: outgoing money is either an obligation or a plan; incoming has no
   * requirement. Defaulting outgoing to `required` is the conservative choice —
   * it keeps obligation coverage honest when the user doesn't say.
   */
  private resolveRequirement(
    direction: string,
    requirement?: 'required' | 'planned',
  ): CashflowRequirement {
    if (direction === 'incoming') {
      return null;
    }
    return requirement ?? 'required';
  }

  private assertValid(event: CashflowEvent): void {
    if (!event.name) {
      throw new BadRequestException('name is required');
    }
    if (!Number.isFinite(event.amount) || event.amount < 0) {
      throw new BadRequestException('amount must be a non-negative number');
    }
    if (!event.expectedDate) {
      throw new BadRequestException('expectedDate is required');
    }
    if (event.direction !== 'incoming' && event.direction !== 'outgoing') {
      throw new BadRequestException(
        'direction must be "incoming" or "outgoing"',
      );
    }
    if (
      event.recurrenceEndDate &&
      event.recurrenceEndDate < event.expectedDate
    ) {
      throw new BadRequestException(
        'recurrenceEndDate cannot be before expectedDate',
      );
    }
  }

  private async ensureCashflowEvent(householdId: string, eventId: string) {
    const event = await this.cashflowEventsRepository.findCashflowEventById(
      householdId,
      eventId,
    );
    if (!event) {
      throw new NotFoundException(`Cashflow event "${eventId}" was not found`);
    }
    return event;
  }

  /** Today in the household timezone — the only clock read in this service. */
  protected today(): string {
    return todayInTimeZone();
  }
}

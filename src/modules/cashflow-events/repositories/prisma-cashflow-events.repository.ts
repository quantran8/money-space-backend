import { Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../../../common/utils/uuid';
import {
  mapCashflowEvent,
  mapHousehold,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { addDaysIso } from '../../../common/utils/clock';
import { Household } from '../../households/entities/household.entity';
import {
  CashflowEvent,
  LIVE_CASHFLOW_STATUSES,
} from '../entities/cashflow-event.entity';
import {
  CashflowEventFilter,
  CashflowEventsRepository,
} from './cashflow-events.repository.interface';

/**
 * How far back the forecast bundle reads.
 *
 * A monthly series whose stored `expectedDate` is months old still produces
 * occurrences inside today's window, and an overdue bill still has to be paid
 * out of today's cash — so filtering to `expectedDate >= today` would silently
 * drop real obligations. A year covers every supported cadence.
 */
const FORECAST_LOOKBACK_DAYS = 400;

/** Longest supported horizon (90 days) plus slack for recurrence-end checks. */
const FORECAST_LOOKAHEAD_DAYS = 120;

@Injectable()
export class PrismaCashflowEventsRepository
  extends PrismaRepository
  implements CashflowEventsRepository
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

  async findCashflowEventsByHousehold(
    householdId: string,
  ): Promise<CashflowEvent[]> {
    const rows = await this.prisma.cashflowEvent.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { expectedDate: 'asc' },
    });

    return rows.map((row) => mapCashflowEvent(row));
  }

  async findCashflowEventsPage(
    householdId: string,
    filter: CashflowEventFilter,
  ): Promise<CashflowEvent[]> {
    const where: Record<string, unknown> = { householdId, deletedAt: null };

    if (filter.direction) {
      where.direction = filter.direction;
    }
    if (filter.status) {
      // `live` is the useful default for a timeline: everything that still owes
      // money, without listing the six statuses at every call site.
      where.status =
        filter.status === 'live'
          ? { in: [...LIVE_CASHFLOW_STATUSES] }
          : filter.status;
    }
    if (filter.requirement) {
      where.requirement = filter.requirement;
    }
    if (filter.certainty) {
      where.certainty = filter.certainty;
    }
    if (filter.from || filter.to) {
      where.expectedDate = {
        ...(filter.from ? { gte: this.toDate(filter.from) ?? undefined } : {}),
        ...(filter.to ? { lte: this.toDate(filter.to) ?? undefined } : {}),
      };
    }

    const rows = await this.prisma.cashflowEvent.findMany({
      where: where as never,
      orderBy: { expectedDate: 'asc' },
      ...(filter.limit ? { take: filter.limit } : {}),
    });

    return rows.map((row) => mapCashflowEvent(row));
  }

  async findForecastCashflowEvents(
    householdId: string,
  ): Promise<CashflowEvent[]> {
    const today = new Date();
    const iso = today.toISOString().slice(0, 10);

    const rows = await this.prisma.cashflowEvent.findMany({
      where: {
        householdId,
        deletedAt: null,
        // completed / cancelled owe nothing; postponed is fetched so the
        // timeline can show it, and excluded from the balance in the engine.
        status: { notIn: ['completed', 'cancelled'] },
        // Private records never enter shared calculations (§11). Applied here
        // so the hot path never loads them, and re-asserted in the pure engine.
        expectedDate: {
          gte:
            this.toDate(addDaysIso(iso, -FORECAST_LOOKBACK_DAYS)) ?? undefined,
          lte:
            this.toDate(addDaysIso(iso, FORECAST_LOOKAHEAD_DAYS)) ?? undefined,
        },
      } as never,
      orderBy: { expectedDate: 'asc' },
    });

    return rows.map((row) => mapCashflowEvent(row));
  }

  async findCashflowEventById(
    householdId: string,
    eventId: string,
  ): Promise<CashflowEvent | undefined> {
    const row = await this.prisma.cashflowEvent.findFirst({
      where: { id: eventId, householdId, deletedAt: null },
    });

    return row ? mapCashflowEvent(row) : undefined;
  }

  async insertCashflowEvent(event: CashflowEvent): Promise<void> {
    // Single round-trip: insert while deriving `created_by` from the household
    // row. If the household doesn't exist (or is soft-deleted) the SELECT
    // yields no row, nothing is inserted, and we surface a 404.
    //
    // `updated_at` is NOT NULL with no DB default — Prisma's @updatedAt fills
    // it on ORM writes, but a raw INSERT must set it explicitly.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO cashflow_events
        (id, household_id, name, amount, direction, expected_date,
         recurrence, recurrence_end_date, requirement, certainty,
         status, attention_level, visibility_level,
         owner_member_id, debt_id,
         financial_goal_id, planned_asset_id, note, created_by, updated_at)
      SELECT
        ${event.id}::uuid,
        h.id,
        ${event.name},
        ${event.amount}::numeric,
        ${event.direction}::"CashflowDirection",
        ${this.toDate(event.expectedDate)}::date,
        ${event.recurrence}::"RecurrenceFrequency",
        ${this.toDate(event.recurrenceEndDate ?? null)}::date,
        ${event.requirement}::"CashflowRequirement",
        ${event.certainty}::"CashflowCertainty",
        ${event.status}::"CashflowEventStatus",
        ${event.attentionLevel}::"AttentionLevel",
        ${event.visibilityLevel}::"VisibilityLevel",
        ${this.asUuid(event.ownerMemberId ?? null)}::uuid,
        ${event.debtId ?? null}::uuid,
        ${event.financialGoalId ?? null}::uuid,
        ${event.plannedAssetId ?? null}::uuid,
        ${event.note ?? null},
        h.created_by,
        now()
      FROM households h
      WHERE h.id = ${event.householdId}::uuid
        AND h.deleted_at IS NULL
    `;

    if (inserted === 0) {
      throw new NotFoundException(
        `Household "${event.householdId}" was not found`,
      );
    }
  }

  async insertCashflowEvents(events: CashflowEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    // Bulk insert in one round-trip so generating a debt's whole repayment
    // schedule doesn't fire a query per installment — that would blow an
    // interactive transaction's timeout on a pooled connection.
    const household = await this.prisma.household.findFirst({
      where: { id: events[0].householdId, deletedAt: null },
      select: { id: true, createdById: true },
    });
    if (!household) {
      throw new NotFoundException(
        `Household "${events[0].householdId}" was not found`,
      );
    }

    await this.prisma.cashflowEvent.createMany({
      data: events.map((event) => ({
        id: event.id,
        householdId: event.householdId,
        name: event.name,
        amount: event.amount,
        direction: event.direction,
        expectedDate: this.toDate(event.expectedDate) as Date,
        recurrence: event.recurrence,
        recurrenceEndDate: this.toDate(event.recurrenceEndDate ?? null),
        requirement: event.requirement,
        certainty: event.certainty,
        status: event.status,
        attentionLevel: event.attentionLevel,
        visibilityLevel: event.visibilityLevel,
        ownerMemberId: this.asUuid(event.ownerMemberId ?? null),
        debtId: event.debtId ?? null,
        financialGoalId: event.financialGoalId ?? null,
        plannedAssetId: event.plannedAssetId ?? null,
        note: event.note ?? null,
        createdById: household.createdById,
      })) as never,
    });
  }

  async updateCashflowEvent(
    eventId: string,
    event: CashflowEvent,
  ): Promise<void> {
    await this.prisma.cashflowEvent.updateMany({
      where: { id: eventId, householdId: event.householdId, deletedAt: null },
      data: {
        name: event.name,
        amount: event.amount,
        direction: event.direction,
        expectedDate: this.toDate(event.expectedDate),
        recurrence: event.recurrence,
        recurrenceEndDate: this.toDate(event.recurrenceEndDate ?? null),
        requirement: event.requirement,
        certainty: event.certainty,
        status: event.status,
        attentionLevel: event.attentionLevel,
        visibilityLevel: event.visibilityLevel,
        ownerMemberId: this.asUuid(event.ownerMemberId ?? null),
        debtId: event.debtId ?? null,
        financialGoalId: event.financialGoalId ?? null,
        plannedAssetId: event.plannedAssetId ?? null,
        note: event.note ?? null,
        lastCompletedAt: event.lastCompletedAt
          ? new Date(event.lastCompletedAt)
          : null,
        lastCompletedById: this.asUuid(event.lastCompletedById ?? null),
        lastCompletedAmount: event.lastCompletedAmount ?? null,
        lastCompletedAssetId: event.lastCompletedAssetId ?? null,
      } as never,
    });
  }

  async deleteCashflowEvent(eventId: string): Promise<void> {
    await this.prisma.cashflowEvent.updateMany({
      where: { id: eventId },
      data: { deletedAt: new Date() },
    });
  }

  async unlinkCashflowEventFromMoneyEvents(eventId: string): Promise<void> {
    await this.prisma.moneyEvent.updateMany({
      where: { cashflowEventId: eventId },
      data: { cashflowEventId: null },
    });
  }

  async updateOpenCashflowEventAmountsByDebt(
    householdId: string,
    debtId: string,
    fromDate: string,
    newAmount: number,
  ): Promise<void> {
    // An "effective-from-now" repayment-amount change touches only future
    // events that are still open. Recorded repayments are money events, not
    // cashflow rows, so they are inherently untouched.
    await this.prisma.cashflowEvent.updateMany({
      where: {
        householdId,
        debtId,
        deletedAt: null,
        status: { in: [...LIVE_CASHFLOW_STATUSES] },
        expectedDate: { gte: this.toDate(fromDate) ?? undefined },
      } as never,
      data: { amount: newAmount },
    });
  }

  async deleteOpenCashflowEventsByDebt(
    householdId: string,
    debtId: string,
    fromDate?: string,
  ): Promise<void> {
    await this.prisma.cashflowEvent.updateMany({
      where: {
        householdId,
        debtId,
        deletedAt: null,
        status: { in: [...LIVE_CASHFLOW_STATUSES] },
        ...(fromDate
          ? { expectedDate: { gte: this.toDate(fromDate) ?? undefined } }
          : {}),
      } as never,
      data: { deletedAt: new Date() },
    });
  }
}

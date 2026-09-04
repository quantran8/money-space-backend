import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidv7 } from '../../../common/utils/uuid';
import {
  mapHousehold,
  mapMoneyEvent,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Household } from '../../households/entities/household.entity';
import { MoneyEvent } from '../entities/money-event.entity';
import {
  DebtRepaymentInfo,
  MoneyEventsRepository,
} from './money-events.repository.interface';

@Injectable()
export class PrismaMoneyEventsRepository
  extends PrismaRepository
  implements MoneyEventsRepository
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

  async findMoneyEventsByHousehold(householdId: string): Promise<MoneyEvent[]> {
    const events = await this.prisma.moneyEvent.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { eventDate: 'desc' },
    });

    return events.map((event) => mapMoneyEvent(event));
  }

  /**
   * `YYYY-MM` → the half-open date range [firstOfMonth, firstOfNextMonth). Since
   * `event_date` is a pure DATE column, this range is exactly equivalent to the
   * old `isoDate.startsWith('YYYY-MM')` in-memory filter, but indexable.
   */
  private monthRange(month: string): { gte: Date; lt: Date } {
    const gte = new Date(`${month}-01T00:00:00.000Z`);
    const lt = new Date(gte);
    lt.setUTCMonth(lt.getUTCMonth() + 1);
    return { gte, lt };
  }

  private buildEventFilter(
    householdId: string,
    filter: { month?: string; type?: string; categoryId?: string },
  ): Prisma.MoneyEventWhereInput {
    const where: Prisma.MoneyEventWhereInput = {
      householdId,
      deletedAt: null,
    };
    if (filter.month) {
      where.eventDate = this.monthRange(filter.month);
    }
    if (filter.type) {
      where.eventType =
        filter.type as Prisma.EnumMoneyEventTypeFilter['equals'];
    }
    if (filter.categoryId) {
      where.categoryId = filter.categoryId;
    }
    return where;
  }

  async findMoneyEventsPage(
    householdId: string,
    filter: {
      month?: string;
      type?: string;
      categoryId?: string;
      limit?: number;
    },
  ): Promise<{ items: MoneyEvent[]; total: number }> {
    const where = this.buildEventFilter(householdId, filter);
    const take = filter.limit && filter.limit > 0 ? filter.limit : undefined;
    const [rows, total] = await Promise.all([
      this.prisma.moneyEvent.findMany({
        where,
        orderBy: { eventDate: 'desc' },
        ...(take ? { take } : {}),
      }),
      this.prisma.moneyEvent.count({ where }),
    ]);
    return { items: rows.map((event) => mapMoneyEvent(event)), total };
  }

  async summarizeMonth(
    householdId: string,
    month: string,
  ): Promise<{
    recordedCount: number;
    totalIncome: number;
    totalOutcome: number;
  }> {
    const eventDate = this.monthRange(month);
    const [grouped, recordedCount] = await Promise.all([
      this.prisma.moneyEvent.groupBy({
        by: ['direction'],
        where: {
          householdId,
          deletedAt: null,
          eventDate,
          direction: { in: ['inflow', 'outflow'] },
        },
        _sum: { amount: true },
      }),
      this.prisma.moneyEvent.count({
        where: { householdId, deletedAt: null, eventDate },
      }),
    ]);

    let totalIncome = 0;
    let totalOutcome = 0;
    for (const row of grouped) {
      const sum = Math.abs(Number(row._sum.amount ?? 0));
      if (row.direction === 'inflow') {
        totalIncome = sum;
      } else if (row.direction === 'outflow') {
        totalOutcome = sum;
      }
    }
    return { recordedCount, totalIncome, totalOutcome };
  }

  async findMoneyEventsByDebt(
    householdId: string,
    debtId: string,
  ): Promise<MoneyEvent[]> {
    const events = await this.prisma.moneyEvent.findMany({
      where: { householdId, debtId, deletedAt: null },
      orderBy: { eventDate: 'desc' },
    });

    return events.map((event) => mapMoneyEvent(event));
  }

  async findMoneyEventById(
    householdId: string,
    eventId: string,
  ): Promise<MoneyEvent | undefined> {
    const event = await this.prisma.moneyEvent.findFirst({
      where: { id: eventId, householdId, deletedAt: null },
    });

    return event ? mapMoneyEvent(event) : undefined;
  }

  async resolveCategoryId(
    householdId: string,
    ref: { categoryId?: string; code?: string },
  ): Promise<string | undefined> {
    const scope = [{ householdId: null }, { householdId }];

    if (ref.categoryId) {
      const row = await this.prisma.moneyEventCategory.findFirst({
        where: { id: ref.categoryId, deletedAt: null, OR: scope },
        select: { id: true },
      });
      if (row) return row.id;
    }

    if (ref.code) {
      const rows = await this.prisma.moneyEventCategory.findMany({
        where: { code: ref.code, deletedAt: null, OR: scope },
        select: { id: true, householdId: true },
      });
      // The household's own row wins over a system row sharing the code.
      const own = rows.find((row) => row.householdId === householdId);
      return (own ?? rows[0])?.id;
    }

    return undefined;
  }

  async insertMoneyEvent(event: MoneyEvent): Promise<void> {
    // Single round-trip: insert the money event while deriving `created_by`
    // from the household row in one statement. If the household doesn't exist
    // (or is soft-deleted) the SELECT yields no row, nothing is inserted, and
    // we surface a 404 — matching the previous assertHousehold behaviour.
    const eventDate = this.toDate(event.isoDate);

    // `updated_at` is NOT NULL with no DB default — Prisma's @updatedAt fills it
    // on ORM writes, but a raw INSERT must set it explicitly.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO money_events
        (id, household_id, description, event_type, category_id, amount,
         fee_amount, sold_quantity, sold_value, currency, event_date, direction,
         from_asset_id, to_asset_id,
         cashflow_event_id, debt_id, created_by, updated_at)
      SELECT
        ${event.id}::uuid,
        h.id,
        ${event.note},
        ${event.type}::"MoneyEventType",
        ${event.categoryId}::uuid,
        ${event.amount}::numeric,
        ${event.feeAmount ?? 0}::numeric,
        ${event.soldQuantity ?? null}::numeric,
        ${event.soldValue ?? null}::numeric,
        'VND',
        ${eventDate}::date,
        ${event.direction}::"MoneyDirection",
        ${event.fromAssetId ?? null}::uuid,
        ${event.toAssetId ?? null}::uuid,
        ${event.upcomingPaymentId ?? null}::uuid,
        ${event.debtId ?? null}::uuid,
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

  async updateMoneyEvent(eventId: string, event: MoneyEvent): Promise<void> {
    await this.prisma.moneyEvent.updateMany({
      where: { id: eventId, householdId: event.householdId, deletedAt: null },
      data: {
        description: event.note,
        eventType: event.type,
        categoryId: event.categoryId,
        amount: event.amount,
        feeAmount: event.feeAmount ?? 0,
        soldQuantity: event.soldQuantity ?? null,
        soldValue: event.soldValue ?? null,
        // `event_date` is NOT NULL, and `toDate` yields null only for an absent
        // value — so leave the stored date alone rather than writing null.
        eventDate: this.toDate(event.isoDate) ?? undefined,
        direction: event.direction,
        fromAssetId: event.fromAssetId,
        toAssetId: event.toAssetId,
        // The column was renamed to `cashflow_event_id`; the domain entity
        // still calls it `upcomingPaymentId`. The cast that used to sit here
        // hid the mismatch from the compiler — without it, a stale field name
        // fails the build instead of the request.
        cashflowEventId: event.upcomingPaymentId,
        debtId: event.debtId,
      },
    });
  }

  async deleteMoneyEvent(eventId: string): Promise<void> {
    await this.prisma.moneyEvent.updateMany({
      where: { id: eventId },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Soft-delete every non-deleted money event linked to a debt in one bulk
   * statement (instead of N per-row updates). The caller still reverses each
   * event's wallet effects separately — only the row deletes are bulked here.
   */
  async deleteMoneyEventsByDebt(
    householdId: string,
    debtId: string,
  ): Promise<void> {
    await this.prisma.moneyEvent.updateMany({
      where: { householdId, debtId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async findMoneyEventsByAsset(
    householdId: string,
    assetId: string,
  ): Promise<MoneyEvent[]> {
    const rows = await this.prisma.moneyEvent.findMany({
      where: {
        householdId,
        deletedAt: null,
        OR: [{ fromAssetId: assetId }, { toAssetId: assetId }],
      },
      orderBy: { eventDate: 'asc' },
    });
    return rows.map((row) => mapMoneyEvent(row));
  }

  /**
   * Soft-delete every non-deleted money event linked to an asset on either side,
   * in one bulk statement. The caller still reverses each event's wallet effects
   * separately — only the row deletes are bulked here.
   */
  async deleteMoneyEventsByAsset(
    householdId: string,
    assetId: string,
  ): Promise<void> {
    await this.prisma.moneyEvent.updateMany({
      where: {
        householdId,
        deletedAt: null,
        OR: [{ fromAssetId: assetId }, { toAssetId: assetId }],
      },
      data: { deletedAt: new Date() },
    });
  }

  async adjustDebtOutstanding(
    householdId: string,
    debtId: string,
    delta: number,
  ): Promise<void> {
    // Floor at 0 in the same statement (GREATEST) so a payment larger than the
    // remaining balance settles the debt rather than pushing it negative. A
    // repayment passes a negative delta (reduce); reversing one passes a positive
    // delta (raise back). Scoped to the household and skips soft-deleted debts.
    await this.prisma.$executeRaw`
      UPDATE debts
      SET outstanding_amount = GREATEST(0, outstanding_amount + ${delta}::numeric),
          updated_at = now()
      WHERE id = ${debtId}::uuid
        AND household_id = ${householdId}::uuid
        AND deleted_at IS NULL
    `;
  }

  async findDebtRepaymentInfo(
    householdId: string,
    debtId: string,
  ): Promise<DebtRepaymentInfo | undefined> {
    const debt = await this.prisma.debt.findFirst({
      where: { id: debtId, householdId, deletedAt: null },
      select: { lenderType: true, fixedPaymentAmount: true },
    });
    if (!debt) {
      return undefined;
    }
    return {
      lenderType: debt.lenderType,
      fixedPaymentAmount:
        debt.fixedPaymentAmount === null
          ? undefined
          : Number(debt.fixedPaymentAmount),
    };
  }

  async adjustNextUnpaidPayment(
    householdId: string,
    debtId: string,
    afterDate: string,
    delta: number,
  ): Promise<void> {
    // The "next" installment is the earliest still-open cashflow event expected
    // on or after the repayment date. `completed`/`cancelled` are settled
    // history; anything else (expected / pending_confirmation / overdue /
    // postponed) is still owed.
    //
    // NOTE the status values changed with the v3.1 rename: the old filter was
    // `status != 'paid'`, and 'paid' no longer exists.
    const next = await this.prisma.cashflowEvent.findFirst({
      where: {
        householdId,
        debtId,
        deletedAt: null,
        status: { notIn: ['completed', 'cancelled'] },
        expectedDate: { gte: this.toDate(afterDate) ?? undefined },
      },
      orderBy: { expectedDate: 'asc' },
      select: { id: true, amount: true },
    });
    if (!next) {
      return;
    }
    const nextAmount = Math.max(0, Number(next.amount) + delta);
    await this.prisma.cashflowEvent.update({
      where: { id: next.id },
      data: { amount: nextAmount },
    });
  }
}

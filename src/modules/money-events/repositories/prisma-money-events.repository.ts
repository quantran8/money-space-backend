import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  mapHousehold,
  mapMoneyEvent,
  normalizeMoneyEventCategory,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Household } from '../../households/entities/household.entity';
import { MoneyEvent } from '../entities/money-event.entity';
import { MoneyEventsRepository } from './money-events.repository.interface';

@Injectable()
export class PrismaMoneyEventsRepository
  extends PrismaRepository
  implements MoneyEventsRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(_prefix: string): string {
    return randomUUID();
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

  async findMoneyEventById(
    householdId: string,
    eventId: string,
  ): Promise<MoneyEvent | undefined> {
    const event = await this.prisma.moneyEvent.findFirst({
      where: { id: eventId, householdId, deletedAt: null },
    });

    return event ? mapMoneyEvent(event) : undefined;
  }

  async insertMoneyEvent(event: MoneyEvent): Promise<void> {
    // Single round-trip: insert the money event while deriving `created_by`
    // from the household row in one statement. If the household doesn't exist
    // (or is soft-deleted) the SELECT yields no row, nothing is inserted, and
    // we surface a 404 — matching the previous assertHousehold behaviour.
    const eventDate = this.toDate(event.isoDate);
    const category = normalizeMoneyEventCategory(event.category);

    // `updated_at` is NOT NULL with no DB default — Prisma's @updatedAt fills it
    // on ORM writes, but a raw INSERT must set it explicitly.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO money_events
        (id, household_id, title, description, event_type, category, amount,
         currency, event_date, direction, from_asset_id, to_asset_id,
         upcoming_payment_id, debt_id, financial_goal_id, created_by, updated_at)
      SELECT
        ${event.id}::uuid,
        h.id,
        ${event.title},
        ${event.note},
        ${event.type}::"MoneyEventType",
        ${category}::"MoneyEventCategory",
        ${event.amount}::numeric,
        'VND',
        ${eventDate}::date,
        ${event.direction}::"MoneyDirection",
        ${event.fromAssetId ?? null}::uuid,
        ${event.toAssetId ?? null}::uuid,
        ${event.upcomingPaymentId ?? null}::uuid,
        ${event.debtId ?? null}::uuid,
        ${event.financialGoalId ?? null}::uuid,
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
        title: event.title,
        description: event.note,
        eventType: event.type,
        category: normalizeMoneyEventCategory(event.category),
        amount: event.amount,
        eventDate: this.toDate(event.isoDate),
        direction: event.direction,
        fromAssetId: event.fromAssetId,
        toAssetId: event.toAssetId,
        upcomingPaymentId: event.upcomingPaymentId,
        debtId: event.debtId,
        financialGoalId: event.financialGoalId,
      } as any,
    });
  }

  async deleteMoneyEvent(eventId: string): Promise<void> {
    await this.prisma.moneyEvent.updateMany({
      where: { id: eventId },
      data: { deletedAt: new Date() },
    });
  }
}

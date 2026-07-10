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
    const household = await this.assertHousehold(event.householdId);
    await this.prisma.moneyEvent.create({
      data: {
        id: event.id,
        householdId: event.householdId,
        title: event.title,
        description: event.note,
        eventType: event.type,
        category: normalizeMoneyEventCategory(event.category),
        amount: event.amount,
        currency: 'VND',
        eventDate: this.toDate(event.isoDate),
        direction: event.direction,
        fromAssetId: event.fromAssetId,
        toAssetId: event.toAssetId,
        upcomingPaymentId: event.upcomingPaymentId,
        debtId: event.debtId,
        financialGoalId: event.financialGoalId,
        createdById: household.createdBy,
      } as any,
    });
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

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { MoneyEvent } from './entities/money-event.entity';
import {
  deriveDirection,
  toMoneyEventCard,
} from '../../common/utils/money-space.utils';
import type { CreateMoneyEventDto } from './dto/create-money-event.dto';
import type { ListMoneyEventsQuery } from './dto/list-money-events.query';
import type { UpdateMoneyEventDto } from './dto/update-money-event.dto';
import { MONEY_EVENTS_REPOSITORY } from './repositories/money-events.repository.interface';
import type { MoneyEventsRepository } from './repositories/money-events.repository.interface';

@Injectable()
export class MoneyEventsService {
  constructor(
    @Inject(MONEY_EVENTS_REPOSITORY)
    private readonly moneyEventsRepository: MoneyEventsRepository,
  ) {}

  async listMoneyEvents(householdId: string, query?: ListMoneyEventsQuery) {
    await this.moneyEventsRepository.assertHousehold(householdId);
    let items =
      await this.moneyEventsRepository.findMoneyEventsByHousehold(householdId);

    if (query?.month) {
      const month = query.month;
      items = items.filter((event) => event.isoDate.startsWith(month));
    }
    if (query?.type) {
      items = items.filter((event) => event.type === query.type);
    }
    if (query?.category) {
      items = items.filter((event) => event.category === query.category);
    }
    if (query?.limit) {
      const limit = Number(query.limit);
      if (Number.isFinite(limit) && limit > 0) {
        items = items.slice(0, limit);
      }
    }

    return {
      householdId,
      items: items.map((event) => toMoneyEventCard(event)),
      total: items.length,
    };
  }

  async getMoneyEvent(householdId: string, eventId: string) {
    return toMoneyEventCard(await this.ensureMoneyEvent(householdId, eventId));
  }

  async createMoneyEvent(householdId: string, payload: CreateMoneyEventDto) {
    // `insertMoneyEvent` asserts the household exists (and needs its row to
    // resolve `createdById`), so we don't assert it a second time here.
    const event: MoneyEvent = {
      id: this.moneyEventsRepository.createId('event'),
      householdId,
      title: payload.title.trim(),
      amount: payload.amount,
      note: payload.note?.trim() ?? '',
      isoDate: payload.isoDate,
      type: payload.type,
      category: payload.category,
      direction: deriveDirection(payload.type, payload.direction),
      fromAssetId: payload.fromAssetId,
      toAssetId: payload.toAssetId,
      upcomingPaymentId: payload.upcomingPaymentId,
      debtId: payload.debtId,
      financialGoalId: payload.financialGoalId,
    };

    await this.moneyEventsRepository.insertMoneyEvent(event);
    return toMoneyEventCard(event);
  }

  async updateMoneyEvent(
    householdId: string,
    eventId: string,
    payload: UpdateMoneyEventDto,
  ) {
    const event = await this.ensureMoneyEvent(householdId, eventId);
    const nextType = payload.type ?? event.type;
    const next: MoneyEvent = {
      ...event,
      ...payload,
      id: event.id,
      householdId: event.householdId,
      title: payload.title?.trim() ?? event.title,
      note: payload.note?.trim() ?? event.note,
      type: nextType,
      direction: deriveDirection(
        nextType,
        payload.direction ?? event.direction,
      ),
      category: payload.category ?? event.category,
      isoDate: payload.isoDate ?? event.isoDate,
      amount: payload.amount ?? event.amount,
    };

    await this.moneyEventsRepository.updateMoneyEvent(eventId, next);
    return toMoneyEventCard(next);
  }

  async deleteMoneyEvent(householdId: string, eventId: string) {
    await this.ensureMoneyEvent(householdId, eventId);
    await this.moneyEventsRepository.deleteMoneyEvent(eventId);
    return {
      deleted: true,
      eventId,
    };
  }

  private async ensureMoneyEvent(householdId: string, eventId: string) {
    // Querying by { id, householdId, deletedAt: null } already returns
    // undefined when the row (or its household) is absent, so a separate
    // assertHousehold round-trip is redundant — the NotFoundException below
    // preserves the 404 semantics.
    const event = await this.moneyEventsRepository.findMoneyEventById(
      householdId,
      eventId,
    );
    if (!event) {
      throw new NotFoundException(`Money event "${eventId}" was not found`);
    }
    return event;
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { MoneyEventsService } from './money-events.service';
import type { CreateMoneyEventDto } from './dto/create-money-event.dto';
import type { ListMoneyEventsQuery } from './dto/list-money-events.query';
import type { UpdateMoneyEventDto } from './dto/update-money-event.dto';

@Controller('api/households/:householdId/money-events')
export class MoneyEventsController {
  constructor(private readonly moneyEventsService: MoneyEventsService) {}

  @Get()
  listMoneyEvents(
    @Param('householdId') householdId: string,
    @Query() query: ListMoneyEventsQuery,
  ) {
    return this.moneyEventsService.listMoneyEvents(householdId, query);
  }

  @Get(':eventId')
  getMoneyEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.moneyEventsService.getMoneyEvent(householdId, eventId);
  }

  @Post()
  createMoneyEvent(
    @Param('householdId') householdId: string,
    @Body() payload: CreateMoneyEventDto,
  ) {
    return this.moneyEventsService.createMoneyEvent(householdId, payload);
  }

  @Patch(':eventId')
  updateMoneyEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Body() payload: UpdateMoneyEventDto,
  ) {
    return this.moneyEventsService.updateMoneyEvent(
      householdId,
      eventId,
      payload,
    );
  }

  @Delete(':eventId')
  deleteMoneyEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.moneyEventsService.deleteMoneyEvent(householdId, eventId);
  }
}

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
import { CashflowEventsService } from './cashflow-events.service';
import type { CreateCashflowEventDto } from './dto/create-cashflow-event.dto';
import type { UpdateCashflowEventDto } from './dto/update-cashflow-event.dto';
import type { CompleteCashflowEventDto } from './dto/complete-cashflow-event.dto';
import type { ListCashflowEventsQuery } from './dto/list-cashflow-events.query';

/**
 * Replaces `/upcoming-payments` (spec §18). Not an alias — the payload shape
 * changed (`dueDate` → `expectedDate`, plus direction/certainty/requirement),
 * so a silent redirect would hand clients data they'd misread.
 */
@Controller('api/households/:householdId/cashflow-events')
export class CashflowEventsController {
  constructor(private readonly cashflowEvents: CashflowEventsService) {}

  @Get()
  listCashflowEvents(
    @Param('householdId') householdId: string,
    @Query() query: ListCashflowEventsQuery,
  ) {
    return this.cashflowEvents.listCashflowEvents(householdId, query);
  }

  @Get(':eventId')
  getCashflowEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.cashflowEvents.getCashflowEvent(householdId, eventId);
  }

  @Post()
  createCashflowEvent(
    @Param('householdId') householdId: string,
    @Body() payload: CreateCashflowEventDto,
  ) {
    return this.cashflowEvents.createCashflowEvent(householdId, payload);
  }

  @Patch(':eventId')
  updateCashflowEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Body() payload: UpdateCashflowEventDto,
  ) {
    return this.cashflowEvents.updateCashflowEvent(
      householdId,
      eventId,
      payload,
    );
  }

  /**
   * Record that the expected movement actually happened. For a recurring event
   * this advances `expectedDate` to the next occurrence rather than closing the
   * record — see the service.
   */
  @Post(':eventId/complete')
  completeCashflowEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Body() payload: CompleteCashflowEventDto,
  ) {
    return this.cashflowEvents.completeCashflowEvent(
      householdId,
      eventId,
      payload,
    );
  }

  @Post(':eventId/postpone')
  postponeCashflowEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Body() payload: { newExpectedDate: string; note?: string },
  ) {
    return this.cashflowEvents.postponeCashflowEvent(
      householdId,
      eventId,
      payload,
    );
  }

  @Post(':eventId/cancel')
  cancelCashflowEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Body() payload: { note?: string },
  ) {
    return this.cashflowEvents.cancelCashflowEvent(
      householdId,
      eventId,
      payload,
    );
  }

  @Delete(':eventId')
  deleteCashflowEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.cashflowEvents.deleteCashflowEvent(householdId, eventId);
  }
}

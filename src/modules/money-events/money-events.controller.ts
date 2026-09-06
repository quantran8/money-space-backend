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
import { Public } from '../auth/decorators/public.decorator';

@Controller('households/:householdId/money-events')
export class MoneyEventsController {
  constructor(private readonly moneyEventsService: MoneyEventsService) {}

  @Get()
  listMoneyEvents(
    @Param('householdId') householdId: string,
    @Query() query: ListMoneyEventsQuery,
  ) {
    return this.moneyEventsService.listMoneyEvents(householdId, query);
  }

  /**
   * Monthly thu/chi/net aggregate for the events summary card. Declared before
   * the `:eventId` route so "summary" isn't captured as an event id. `month` is
   * `YYYY-MM`; omitted → the current month.
   */
  @Get('summary')
  getMoneyEventsSummary(
    @Param('householdId') householdId: string,
    @Query('month') month?: string,
  ) {
    return this.moneyEventsService.getMoneyEventsSummary(householdId, month);
  }

  /**
   * Events sitting where their wallet's balance is negative, so the list can mark
   * them. Declared before `:eventId` so "overdrafts" isn't read as an event id.
   */
  @Get('overdrafts')
  listOverdraftEvents(@Param('householdId') householdId: string) {
    return this.moneyEventsService.listOverdraftEvents(householdId);
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

  // The two `@Public()` accrual endpoints that used to sit here are gone.
  // They were an unauthenticated seam for an external worker that was never
  // built, so nothing ever called them and no interest was ever credited.
  // `SavingDepositCron` now runs accrual (and settlement) in-process — see
  // memory/asset-valuation.md. `MoneyEventsService.accrueHouseholdInterest`
  // survives as the service method the cron calls.

  /**
   * Advisory: what this edit would do to the wallets it touches, without writing
   * it. The client shows the warning and asks for confirmation; the edit itself
   * does not consult this, so a skipped preview never blocks a legitimate change.
   * POST because the candidate payload is the input, not an addressable resource.
   */
  @Post(':eventId/preview')
  previewMoneyEventUpdate(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Body() payload: UpdateMoneyEventDto,
  ) {
    return this.moneyEventsService.previewMoneyEventUpdate(
      householdId,
      eventId,
      payload,
    );
  }

  /** Advisory: what deleting this event would do to its wallets. */
  @Get(':eventId/delete-impact')
  previewMoneyEventDelete(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.moneyEventsService.previewMoneyEventDelete(
      householdId,
      eventId,
    );
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

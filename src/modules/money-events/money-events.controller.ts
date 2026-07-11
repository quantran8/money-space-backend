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
import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { Public } from '../auth/decorators/public.decorator';

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

  @RequireCapability('edit')
  @Post()
  createMoneyEvent(
    @Param('householdId') householdId: string,
    @Body() payload: CreateMoneyEventDto,
  ) {
    return this.moneyEventsService.createMoneyEvent(householdId, payload);
  }

  /**
   * Auto-credit due saving-deposit interest across the whole household.
   * Idempotent — an external worker can call this on a schedule. See
   * {@link MoneyEventsService.accrueHouseholdInterest}.
   */
  // Worker-called (external scheduler, no request user) — public seam, like the
  // rest of the accrual flow. NOT a member action, so no capability check.
  @Public()
  @Post('accrue-interest')
  accrueHouseholdInterest(@Param('householdId') householdId: string) {
    return this.moneyEventsService.accrueHouseholdInterest(householdId);
  }

  /** Auto-credit due interest on a single saving deposit. Idempotent. */
  @Public()
  @Post('assets/:assetId/accrue-interest')
  accrueSavingInterestForAsset(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.moneyEventsService.accrueSavingInterestForAsset(
      householdId,
      assetId,
    );
  }

  @RequireCapability('edit')
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

  @RequireCapability('edit')
  @Delete(':eventId')
  deleteMoneyEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.moneyEventsService.deleteMoneyEvent(householdId, eventId);
  }
}

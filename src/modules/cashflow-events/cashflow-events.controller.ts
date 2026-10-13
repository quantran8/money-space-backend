import {
  BadRequestException,
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
import { CashflowSettlementService } from './services/cashflow-settlement.service';
import { CashflowMatcherService } from './services/cashflow-matcher.service';
import type { CreateCashflowEventDto } from './dto/create-cashflow-event.dto';
import type { UpdateCashflowEventDto } from './dto/update-cashflow-event.dto';
import type { CompleteCashflowEventDto } from './dto/complete-cashflow-event.dto';
import type { ListCashflowEventsQuery } from './dto/list-cashflow-events.query';
import { NoCacheInvalidation } from '../../common/cache/no-cache-invalidation.decorator';
import { CurrentMembership } from '../auth/decorators/current-membership.decorator';
import type { HouseholdMembership } from '../auth/guards/household-access.guard';

/**
 * Replaces `/upcoming-payments` (spec §18). Not an alias — the payload shape
 * changed (`dueDate` → `expectedDate`, plus direction/certainty/requirement),
 * so a silent redirect would hand clients data they'd misread.
 */
@Controller('households/:householdId/cashflow-events')
export class CashflowEventsController {
  constructor(
    private readonly cashflowEvents: CashflowEventsService,
    private readonly settlement: CashflowSettlementService,
    private readonly matcher: CashflowMatcherService,
  ) {}

  @Get('match-rules')
  listHouseholdMatchRules(@Param('householdId') householdId: string) {
    return this.matcher.listHouseholdRules(householdId);
  }

  @NoCacheInvalidation()
  @Post('match-rules/preview')
  previewMatchRule(
    @Param('householdId') householdId: string,
    @Body() body: { phrase?: string },
  ) {
    return this.matcher.previewRule(householdId, body?.phrase ?? '');
  }

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
    @CurrentMembership() membership?: HouseholdMembership,
  ) {
    return this.cashflowEvents.createCashflowEvent(
      householdId,
      payload,
      membership?.memberId,
    );
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
    @CurrentMembership() membership: HouseholdMembership,
  ) {
    return this.cashflowEvents.completeCashflowEvent(
      householdId,
      eventId,
      payload,
      membership.userId,
    );
  }

  @Get(':eventId/link-candidates')
  linkCandidates(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Query('q') q?: string,
  ) {
    return this.settlement.linkCandidates(householdId, eventId, q);
  }

  @Get(':eventId/settlements')
  listSettlements(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.settlement.listSettlements(householdId, eventId);
  }

  @Post(':eventId/link')
  linkMoneyEvent(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Body() body: { moneyEventId?: string },
    @CurrentMembership() membership: HouseholdMembership,
  ) {
    if (!body?.moneyEventId) {
      throw new BadRequestException('moneyEventId is required');
    }
    return this.settlement.settleExisting(
      householdId,
      eventId,
      body.moneyEventId,
      'manual_link',
      membership.userId,
    );
  }

  @Post(':eventId/replace-manual')
  replaceManual(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Body() body: { moneyEventId?: string },
    @CurrentMembership() membership: HouseholdMembership,
  ) {
    if (!body?.moneyEventId) {
      throw new BadRequestException('moneyEventId is required');
    }
    return this.settlement.replaceManualWithBank(
      householdId,
      eventId,
      body.moneyEventId,
      membership.userId,
    );
  }

  @Post(':eventId/unlink')
  unlinkMoneyEvent(
    @Param('householdId') householdId: string,
    @Body() body: { moneyEventId?: string },
  ) {
    if (!body?.moneyEventId) {
      throw new BadRequestException('moneyEventId is required');
    }
    return this.settlement.unsettle(householdId, body.moneyEventId);
  }

  @Get(':eventId/match-rules')
  listMatchRules(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.matcher.listRules(householdId, eventId);
  }

  @Post(':eventId/match-rules')
  createMatchRule(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Body() body: { phrase?: string },
    @CurrentMembership() membership: HouseholdMembership,
  ) {
    return this.matcher.createRule(
      householdId,
      eventId,
      body?.phrase ?? '',
      membership.userId,
    );
  }

  @Delete(':eventId/match-rules/:ruleId')
  deleteMatchRule(
    @Param('householdId') householdId: string,
    @Param('eventId') eventId: string,
    @Param('ruleId') ruleId: string,
  ) {
    return this.matcher.deleteRule(householdId, eventId, ruleId);
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

import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentMembership } from '../auth/decorators/current-membership.decorator';
import type { HouseholdMembership } from '../auth/guards/household-access.guard';
import type { RedeemCodeDto } from './dto/redeem-code.dto';
import { RedeemService } from './redeem.service';

/**
 * Redeeming is household-scoped, and any member may do it.
 *
 * Deliberately NOT behind `@RequireHouseholdCreator()`: that guard covers the
 * three operations that change *who is in the room*, each irreversible.
 * Redeeming only ever adds capability, for both people. Making one partner wait
 * for the other to open the app before a code they just bought will work is
 * friction with nothing behind it — the journal records who did it.
 */
@Controller('households/:householdId/redeem-codes')
export class RedeemController {
  constructor(private readonly redeem: RedeemService) {}

  /** What the code would do, without spending it. */
  @Post('preview')
  preview(
    @Param('householdId') householdId: string,
    @Body() payload: RedeemCodeDto,
  ) {
    if (!payload?.code) {
      throw new BadRequestException('code is required');
    }
    return this.redeem.preview(householdId, payload.code);
  }

  @Post('redeem')
  redeemCode(
    @Param('householdId') householdId: string,
    @Body() payload: RedeemCodeDto,
    @CurrentMembership() membership?: HouseholdMembership,
  ) {
    if (!payload?.code) {
      throw new BadRequestException('code is required');
    }
    if (!membership) {
      throw new BadRequestException('household membership is required');
    }
    return this.redeem.redeem(householdId, membership.userId, payload.code);
  }
}

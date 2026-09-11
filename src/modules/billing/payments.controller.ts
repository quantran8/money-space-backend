import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentMembership } from '../auth/decorators/current-membership.decorator';
import type { HouseholdMembership } from '../auth/guards/household-access.guard';
import { PaymentsService } from './payments.service';

/**
 * Buying a plan. Household-scoped, and any member may do it — same reasoning
 * as redeeming: paying only ever adds capability, for both people, and the
 * journal records who did it.
 */
@Controller('households/:householdId/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Open a checkout and hand back the hosted URL to redirect to.
   *
   * The body names only the PLAN. The amount is resolved server-side from
   * `buildPlanOffers` — a client that could name its own price could buy a
   * lifetime plan for 1.000đ.
   */
  @Post('orders')
  createOrder(
    @Param('householdId') householdId: string,
    @Body() payload: { planCode?: string; fromReason?: string },
    @CurrentMembership() membership?: HouseholdMembership,
  ) {
    if (!payload?.planCode) {
      throw new BadRequestException('planCode is required');
    }
    if (!membership) {
      throw new BadRequestException('household membership is required');
    }
    return this.payments.createOrder(
      householdId,
      membership.userId,
      payload.planCode,
      // Telemetry only. An unrecognised value becomes null rather than a 400 —
      // an attribution tag must never be able to fail a payment.
      payload.fromReason,
    );
  }

  /** What the return page polls. */
  @Get('orders/:orderCode')
  getOrder(
    @Param('householdId') householdId: string,
    @Param('orderCode') orderCode: string,
  ) {
    return this.payments.getOrderStatus(householdId, orderCode);
  }

  @Get('orders')
  listOrders(@Param('householdId') householdId: string) {
    return this.payments.listOrders(householdId);
  }

  @Post('orders/:orderCode/cancel')
  cancelOrder(
    @Param('householdId') householdId: string,
    @Param('orderCode') orderCode: string,
  ) {
    return this.payments.cancelOrder(householdId, orderCode);
  }
}

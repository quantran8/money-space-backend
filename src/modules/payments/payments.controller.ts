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
import { PaymentsService } from './payments.service';
import type { CreateUpcomingPaymentDto } from './dto/create-upcoming-payment.dto';
import type { ListUpcomingPaymentsQuery } from './dto/list-upcoming-payments.query';
import type { UpdateUpcomingPaymentDto } from './dto/update-upcoming-payment.dto';

@Controller('api/households/:householdId/upcoming-payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  listUpcomingPayments(
    @Param('householdId') householdId: string,
    @Query() query: ListUpcomingPaymentsQuery,
  ) {
    return this.paymentsService.listUpcomingPayments(householdId, query);
  }

  @Get(':paymentId')
  getUpcomingPayment(
    @Param('householdId') householdId: string,
    @Param('paymentId') paymentId: string,
  ) {
    return this.paymentsService.getUpcomingPayment(householdId, paymentId);
  }

  @Post()
  createUpcomingPayment(
    @Param('householdId') householdId: string,
    @Body() payload: CreateUpcomingPaymentDto,
  ) {
    return this.paymentsService.createUpcomingPayment(householdId, payload);
  }

  @Patch(':paymentId')
  updateUpcomingPayment(
    @Param('householdId') householdId: string,
    @Param('paymentId') paymentId: string,
    @Body() payload: UpdateUpcomingPaymentDto,
  ) {
    return this.paymentsService.updateUpcomingPayment(
      householdId,
      paymentId,
      payload,
    );
  }

  @Delete(':paymentId')
  deleteUpcomingPayment(
    @Param('householdId') householdId: string,
    @Param('paymentId') paymentId: string,
  ) {
    return this.paymentsService.deleteUpcomingPayment(householdId, paymentId);
  }
}

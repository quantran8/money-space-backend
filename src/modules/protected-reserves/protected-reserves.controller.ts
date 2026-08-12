import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ProtectedReservesService } from './protected-reserves.service';
import type { CreateProtectedReserveDto } from './dto/create-protected-reserve.dto';
import type { UpdateProtectedReserveDto } from './dto/update-protected-reserve.dto';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';

@Controller('api/households/:householdId/protected-reserves')
export class ProtectedReservesController {
  constructor(private readonly reserves: ProtectedReservesService) {}

  @Get()
  listProtectedReserves(@Param('householdId') householdId: string) {
    return this.reserves.listProtectedReserves(householdId);
  }

  @Get(':reserveId')
  getProtectedReserve(
    @Param('householdId') householdId: string,
    @Param('reserveId') reserveId: string,
  ) {
    return this.reserves.getProtectedReserve(householdId, reserveId);
  }

  @RequireCapability('edit')
  @Post()
  createProtectedReserve(
    @Param('householdId') householdId: string,
    @Body() payload: CreateProtectedReserveDto,
  ) {
    return this.reserves.createProtectedReserve(householdId, payload);
  }

  @RequireCapability('edit')
  @Patch(':reserveId')
  updateProtectedReserve(
    @Param('householdId') householdId: string,
    @Param('reserveId') reserveId: string,
    @Body() payload: UpdateProtectedReserveDto,
  ) {
    return this.reserves.updateProtectedReserve(
      householdId,
      reserveId,
      payload,
    );
  }

  @RequireCapability('edit')
  @Delete(':reserveId')
  deleteProtectedReserve(
    @Param('householdId') householdId: string,
    @Param('reserveId') reserveId: string,
  ) {
    return this.reserves.deleteProtectedReserve(householdId, reserveId);
  }
}

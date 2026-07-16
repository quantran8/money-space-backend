import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import type { CreateHouseholdDto } from './dto/create-household.dto';
import { HouseholdsService } from './households.service';

@Controller('api/households')
@UseGuards(SupabaseAuthGuard)
export class HouseholdsController {
  constructor(private readonly householdsService: HouseholdsService) {}

  @Get()
  listHouseholds(@CurrentUser() user: AuthUser) {
    return this.householdsService.listMyHouseholds(user);
  }

  @Post()
  createHousehold(
    @CurrentUser() user: AuthUser,
    @Body() payload: CreateHouseholdDto,
  ) {
    return this.householdsService.createHousehold(user, payload);
  }

  @Get(':householdId')
  getHousehold(@Param('householdId') householdId: string) {
    return this.householdsService.getHousehold(householdId);
  }

  @Patch(':householdId/config')
  updateConfig(
    @Param('householdId') householdId: string,
    @Body() payload: { currency?: string },
  ) {
    return this.householdsService.updateConfig(householdId, payload);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { MoneyEventCategoriesService } from './money-event-categories.service';
import type { CreateMoneyEventCategoryDto } from './dto/create-money-event-category.dto';
import type { UpdateMoneyEventCategoryDto } from './dto/update-money-event-category.dto';
import type { SetDefaultCategoryDto } from './dto/set-default-category.dto';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';

@Controller('api/households/:householdId/money-event-categories')
export class MoneyEventCategoriesController {
  constructor(private readonly service: MoneyEventCategoriesService) {}

  @Get()
  listCategories(@Param('householdId') householdId: string) {
    return this.service.listCategories(householdId);
  }

  @RequireCapability('edit')
  @Post()
  createCategory(
    @Param('householdId') householdId: string,
    @Body() payload: CreateMoneyEventCategoryDto,
  ) {
    return this.service.createCategory(householdId, payload);
  }

  /**
   * Set (or clear) the household's default money-event category by CODE. Works
   * for system and custom categories alike (the default is a per-household
   * pointer, not a row flag). Declared before `:categoryId` so the fixed
   * "default" segment isn't captured as a category id.
   */
  @RequireCapability('edit')
  @Put('default')
  setDefaultCategory(
    @Param('householdId') householdId: string,
    @Body() payload: SetDefaultCategoryDto,
  ) {
    return this.service.setDefaultCategory(householdId, payload.code ?? null);
  }

  @RequireCapability('edit')
  @Patch(':categoryId')
  updateCategory(
    @Param('householdId') householdId: string,
    @Param('categoryId') categoryId: string,
    @Body() payload: UpdateMoneyEventCategoryDto,
  ) {
    return this.service.updateCategory(householdId, categoryId, payload);
  }

  @RequireCapability('edit')
  @Delete(':categoryId')
  deleteCategory(
    @Param('householdId') householdId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.service.deleteCategory(householdId, categoryId);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { MoneyEventCategoriesService } from './money-event-categories.service';
import type { CreateMoneyEventCategoryDto } from './dto/create-money-event-category.dto';
import type { UpdateMoneyEventCategoryDto } from './dto/update-money-event-category.dto';
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

import { Controller, Get, Param } from '@nestjs/common';
import { AttentionService } from './attention.service';

@Controller('households/:householdId/attention-items')
export class AttentionController {
  constructor(private readonly attention: AttentionService) {}

  /**
   * Every attention signal for this household. Read-only by design: signals are
   * DERIVED on each read from the forecast bundle, so there is nothing to flag,
   * acknowledge or dismiss — a signal exists exactly while its condition holds.
   * The stored-item routes and the `attention_items` table were dropped
   * (2026-08-29); see the service for why.
   */
  @Get()
  listAttentionItems(@Param('householdId') householdId: string) {
    return this.attention.listAttentionItems(householdId);
  }
}

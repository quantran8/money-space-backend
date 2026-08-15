import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AttentionService } from './attention.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import type { StoredAttentionItem } from './entities/attention-item.entity';

@Controller('api/households/:householdId/attention-items')
export class AttentionController {
  constructor(private readonly attention: AttentionService) {}

  @Get()
  listAttentionItems(@Param('householdId') householdId: string) {
    return this.attention.listAttentionItems(householdId);
  }

  @Post()
  flagAttentionItem(
    @Param('householdId') householdId: string,
    @Body()
    payload: {
      title: string;
      reason?: string;
      level?: 'normal' | 'important' | 'urgent';
      relatedObjectType?: StoredAttentionItem['relatedObjectType'];
      relatedObjectId?: string;
    },
    @CurrentUser() user?: AuthUser,
  ) {
    return this.attention.flagAttentionItem(householdId, payload, user?.id);
  }

  /**
   * Marking something seen is not an edit — it records that a member looked at
   * it. A `view_summary` partner must be able to acknowledge what they were
   * shown, so this carries no capability requirement.
   */
  @Post(':itemId/seen')
  markSeen(
    @Param('householdId') householdId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.attention.markSeen(householdId, itemId, user?.id);
  }

  @Post(':itemId/resolve')
  markResolved(
    @Param('householdId') householdId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.attention.markResolved(householdId, itemId, user?.id);
  }

  @Post(':itemId/dismiss')
  markDismissed(
    @Param('householdId') householdId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.attention.markDismissed(householdId, itemId, user?.id);
  }

  /**
   * Dismiss a DERIVED signal, which has no row to PATCH — the body carries the
   * rule code + related object instead of an id. Separate route because a
   * derived id (`derived:…`) is not addressable as a resource.
   */
  @Post('dismiss-derived')
  dismissDerived(
    @Param('householdId') householdId: string,
    @Body() payload: { ruleCode: string; relatedObjectId?: string | null },
    @CurrentUser() user?: AuthUser,
  ) {
    return this.attention.dismissDerived(householdId, payload, user?.id);
  }
}

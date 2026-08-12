import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { InvitesService } from './invites.service';
import type { CreateInviteDto } from './dto/create-invite.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';

/**
 * The INVITER's side. Household-scoped and admin-only: handing someone access
 * to the household's money is a membership decision, not content editing.
 *
 * The invitee's side lives in `invite-tokens.controller.ts`, on a route with no
 * `:householdId` — see that file for why it must.
 */
@Controller('api/households/:householdId/invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @RequireCapability('admin')
  @Get()
  listInvites(@Param('householdId') householdId: string) {
    return this.invites.listInvites(householdId);
  }

  @RequireCapability('admin')
  @Post()
  createInvite(
    @Param('householdId') householdId: string,
    @Body() payload: CreateInviteDto,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.invites.createInvite(householdId, payload, user);
  }

  @RequireCapability('admin')
  @Delete(':inviteId')
  revokeInvite(
    @Param('householdId') householdId: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.invites.revokeInvite(householdId, inviteId);
  }
}

import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { InvitesService } from './invites.service';
import type { CreateInviteDto } from './dto/create-invite.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import { RequireHouseholdCreator } from '../auth/decorators/require-household-creator.decorator';

/**
 * The INVITER's side.
 *
 * Only CREATING an invite is restricted, because letting a new person into the
 * household's money changes who is in the room. Reading the pending list and
 * revoking an invite are open to any member: revoking is reversible (re-invite),
 * and gating it would mean a partner who spots a mistaken invitation cannot
 * cancel it — a worse outcome than the one the gate protects against.
 *
 * The invitee's side lives in `invite-tokens.controller.ts`, on a route with no
 * `:householdId` — see that file for why it must.
 */
@Controller('households/:householdId/invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Get()
  listInvites(@Param('householdId') householdId: string) {
    return this.invites.listInvites(householdId);
  }

  @RequireHouseholdCreator()
  @Post()
  createInvite(
    @Param('householdId') householdId: string,
    @Body() payload: CreateInviteDto,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.invites.createInvite(householdId, payload, user);
  }

  // Ungated on purpose — see the class comment. Recorded in the journal.
  @Delete(':inviteId')
  revokeInvite(
    @Param('householdId') householdId: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.invites.revokeInvite(householdId, inviteId);
  }
}

import { Controller, Get, Param, Post } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/entities/auth-user.entity';

/**
 * The INVITEE's side.
 *
 * **This controller must never take a `:householdId` param.**
 * `HouseholdAccessGuard` returns early only when `params.householdId` is
 * absent; the moment a household id appears in the path, the guard demands the
 * caller already be a live member of that household. Putting accept under
 * `/households/:householdId/…` would therefore 403 every invitee for not being
 * a member — which is exactly the state they are trying to leave. The route
 * shape IS the authorization design, not a stylistic choice.
 *
 * Authentication is still required (the global `SupabaseAuthGuard` runs, and
 * these routes are NOT `@Public`): joining a household attaches a real identity
 * to a real member row, so we must know who is joining. What is not required —
 * and cannot be — is prior membership.
 */
@Controller('api/invites')
export class InviteTokensController {
  constructor(private readonly invites: InvitesService) {}

  /**
   * Preview before accepting. Returns the household name, who invited them and
   * the role on offer — and no financial data whatsoever. A token holder has
   * been granted nothing yet.
   */
  @Get(':token')
  previewInvite(@Param('token') token: string) {
    return this.invites.previewInvite(token);
  }

  @Post(':token/accept')
  acceptInvite(
    @Param('token') token: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.invites.acceptInvite(token, user);
  }
}

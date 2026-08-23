import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { HOUSEHOLD_CREATOR_KEY } from '../decorators/require-household-creator.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedRequest } from './supabase-auth.guard';

export interface HouseholdMembership {
  /** Household-member row id used by holder/owner foreign keys. */
  memberId: string;
  householdId: string;
  userId: string;
  /**
   * Whether this member created the household. The only distinction between
   * members, and it gates the three lifecycle operations only — never content.
   */
  isCreator: boolean;
}

export interface RequestWithMembership extends AuthenticatedRequest {
  params?: Record<string, string>;
  membership?: HouseholdMembership;
}

/**
 * Authorization guard for `/api/v1/households/:householdId/*` routes (app-layer, no
 * RLS).
 *
 * Membership IS the content permission: a live member of the household may read
 * and write any financial record in it.
 * There is no role hierarchy and no permission tier between partners — what
 * makes a change accountable is that it lands in the journal, not that it was
 * pre-authorized.
 *
 * The single exception is `@RequireHouseholdCreator()`, which guards the three
 * lifecycle operations (delete household, remove member, invite member). See
 * that decorator for why those three and not others.
 */
@Injectable()
export class HouseholdAccessGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithMembership>();

    const householdId = request.params?.householdId;
    if (!householdId) {
      // Route isn't household-scoped; SupabaseAuthGuard already authenticated.
      return true;
    }

    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('Missing bearer token');
    }

    // Both lookups key off `householdId` alone — the membership row does not
    // depend on the household row existing — so they run concurrently. This
    // guard sits in front of EVERY household-scoped request; awaiting them in
    // sequence put two full DB round-trips ahead of every handler.
    const client = this.prisma.client();
    const [household, member] = await Promise.all([
      client.household.findFirst({
        where: { id: householdId, deletedAt: null },
        select: { id: true, createdById: true },
      }),
      // Existence is the whole question — membership carries no capability of
      // its own any more, so there is nothing else to select.
      client.householdMember.findFirst({
        where: { householdId, userId: user.id, deletedAt: null },
        select: { id: true },
      }),
    ]);

    // Order of checks is preserved: a missing household is a 404 even when the
    // membership row is also absent, so callers can't probe for household
    // existence via the 403.
    if (!household) {
      throw new NotFoundException(`Household "${householdId}" was not found`);
    }
    if (!member) {
      throw new ForbiddenException('You are not a member of this household');
    }

    const isCreator = household.createdById === user.id;
    request.membership = {
      memberId: member.id,
      householdId,
      userId: user.id,
      isCreator,
    };

    const creatorOnly = this.reflector.getAllAndOverride<boolean | undefined>(
      HOUSEHOLD_CREATOR_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (creatorOnly && !isCreator) {
      throw new ForbiddenException(
        'Only the member who created this household can do that',
      );
    }

    return true;
  }
}

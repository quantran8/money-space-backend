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
import {
  effectivePermission,
  type Capability,
  hasCapability,
} from '../../../common/utils/money-space.utils';
import type {
  HouseholdRole,
  PermissionLevel,
} from '../../members/entities/member.entity';
import { CAPABILITY_KEY } from '../decorators/require-capability.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedRequest } from './supabase-auth.guard';

export interface HouseholdMembership {
  householdId: string;
  userId: string;
  role: HouseholdRole;
  permission: PermissionLevel;
  isOwner: boolean;
}

export interface RequestWithMembership extends AuthenticatedRequest {
  params?: Record<string, string>;
  membership?: HouseholdMembership;
}

/**
 * Authorization guard for `/api/households/:householdId/*` routes (app-layer, no
 * RLS). Verifies the authenticated user is a live member of the household, then
 * attaches `req.membership` (role + effective permission). Capability is checked
 * on top of this by `RequireCapabilityGuard` via the `@RequireCapability(...)`
 * decorator; without that decorator, any member may proceed (visibility is
 * still gated per-record at the service layer).
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

    const client = this.prisma.client();
    const household = await client.household.findFirst({
      where: { id: householdId, deletedAt: null },
      select: { id: true, createdById: true },
    });
    if (!household) {
      throw new NotFoundException(`Household "${householdId}" was not found`);
    }

    const member = await client.householdMember.findFirst({
      where: { householdId, userId: user.id, deletedAt: null },
      select: { role: true, permissionLevel: true },
    });
    if (!member) {
      throw new ForbiddenException('You are not a member of this household');
    }

    const permission = effectivePermission(member.role, member.permissionLevel);
    request.membership = {
      householdId,
      userId: user.id,
      role: member.role,
      permission,
      isOwner: household.createdById === user.id,
    };

    // If the handler declared a required capability, enforce it here too so a
    // single guard covers both membership and capability.
    const required = this.reflector.getAllAndOverride<Capability | undefined>(
      CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required && !hasCapability(permission, required)) {
      throw new ForbiddenException(
        `This action requires "${required}" permission`,
      );
    }

    return true;
  }
}

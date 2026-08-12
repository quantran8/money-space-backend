import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import type { CreateInviteDto } from './dto/create-invite.dto';
import type {
  HouseholdInvite,
  InvitePreview,
} from './entities/invite.entity';
import { INVITES_REPOSITORY } from './repositories/invites.repository.interface';
import type { InvitesRepository } from './repositories/invites.repository.interface';

const DEFAULT_EXPIRES_IN_DAYS = 14;
const MAX_EXPIRES_IN_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Household invites (spec §6).
 *
 * The invitee is, at accept time, someone with a token and nothing else — not
 * a member, with no household to be scoped to. Every design decision here
 * follows from that:
 *
 * - the token is looked up ALONE, without a household id;
 * - the pre-accept preview reveals no money, only who is asking and as what;
 * - the accept route lives on a controller with no `:householdId` param, so
 *   `HouseholdAccessGuard` returns early instead of 403-ing the invitee for not
 *   being a member — precisely the state they are trying to leave.
 */
@Injectable()
export class InvitesService {
  constructor(
    @Inject(INVITES_REPOSITORY)
    private readonly invitesRepository: InvitesRepository,
  ) {}

  async listInvites(householdId: string) {
    await this.invitesRepository.assertHousehold(householdId);
    const items =
      await this.invitesRepository.findInvitesByHousehold(householdId);
    return {
      householdId,
      // The inviter needs the token back — it IS the link they share.
      items: items.map((invite) => ({
        ...invite,
        expired: this.isExpired(invite),
      })),
      total: items.length,
    };
  }

  async createInvite(
    householdId: string,
    payload: CreateInviteDto,
    user?: AuthUser,
  ) {
    if (!user?.id) {
      throw new ForbiddenException('An authenticated inviter is required');
    }

    const email = payload.inviteeEmail?.trim();
    const phone = payload.inviteePhone?.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('inviteeEmail is not a valid email');
    }

    const expiresInDays = payload.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
    if (
      !Number.isFinite(expiresInDays) ||
      expiresInDays <= 0 ||
      expiresInDays > MAX_EXPIRES_IN_DAYS
    ) {
      throw new BadRequestException(
        `expiresInDays must be between 1 and ${MAX_EXPIRES_IN_DAYS}`,
      );
    }

    const invite: HouseholdInvite = {
      id: this.invitesRepository.createId('household-invite'),
      householdId,
      invitedById: user.id,
      inviteeEmail: email || null,
      inviteePhone: phone || null,
      token: this.invitesRepository.createToken(),
      status: 'pending',
      defaultRole: payload.defaultRole ?? 'partner',
      defaultPermissionLevel: payload.defaultPermissionLevel ?? null,
      expiresAt: new Date(Date.now() + expiresInDays * DAY_MS).toISOString(),
      acceptedById: null,
      acceptedAt: null,
      createdAt: new Date().toISOString(),
    };

    await this.invitesRepository.insertInvite(invite);
    return invite;
  }

  async revokeInvite(householdId: string, inviteId: string) {
    const invite = await this.invitesRepository.findInviteById(
      householdId,
      inviteId,
    );
    if (!invite) {
      throw new NotFoundException(`Invite "${inviteId}" was not found`);
    }
    if (invite.status === 'accepted') {
      throw new BadRequestException(
        'This invite was already accepted and cannot be revoked',
      );
    }
    await this.invitesRepository.revokeInvite(inviteId);
    return { revoked: true, inviteId };
  }

  /**
   * What the invitee sees before deciding. Contains NO financial data — the
   * holder of a token has not been granted anything yet.
   */
  async previewInvite(token: string): Promise<InvitePreview> {
    const invite = await this.requireInvite(token);
    const context = await this.invitesRepository.findInviteContext(invite.id);
    if (!context) {
      throw new NotFoundException('This invite is no longer available');
    }

    const expired = this.isExpired(invite);
    return {
      householdName: context.householdName,
      invitedByName: context.invitedByName,
      defaultRole: invite.defaultRole,
      // Report `expired` rather than the stored `pending`: the row is only
      // updated lazily, so the timestamp is the truth, not the column.
      status: expired && invite.status === 'pending' ? 'expired' : invite.status,
      expiresAt: invite.expiresAt,
      acceptable: invite.status === 'pending' && !expired,
    };
  }

  async acceptInvite(token: string, user?: AuthUser) {
    if (!user?.id) {
      throw new ForbiddenException('Sign in to accept this invite');
    }

    const invite = await this.requireInvite(token);

    if (invite.status === 'cancelled') {
      throw new BadRequestException('This invite was withdrawn');
    }
    if (invite.status === 'accepted') {
      throw new BadRequestException('This invite was already used');
    }
    if (this.isExpired(invite)) {
      throw new BadRequestException('This invite has expired');
    }

    const result = await this.invitesRepository.acceptInvite(invite, {
      id: user.id,
      email: user.email,
      fullName: user.fullName ?? user.displayName ?? null,
    });

    return {
      householdId: result.householdId,
      memberId: result.memberId,
      role: invite.defaultRole,
      alreadyMember: result.alreadyMember,
    };
  }

  // --- internals -----------------------------------------------------------

  /**
   * One 404 for "no such token" and for "token belongs to a deleted household".
   * Distinguishing them would let anyone probe which tokens ever existed.
   */
  private async requireInvite(token: string): Promise<HouseholdInvite> {
    const trimmed = token?.trim();
    if (!trimmed) {
      throw new NotFoundException('Invite was not found');
    }
    const invite = await this.invitesRepository.findInviteByToken(trimmed);
    if (!invite) {
      throw new NotFoundException('Invite was not found');
    }
    return invite;
  }

  private isExpired(invite: HouseholdInvite): boolean {
    return new Date(invite.expiresAt).getTime() <= Date.now();
  }
}

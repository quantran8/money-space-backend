import type {
  HouseholdRole,
} from '../../members/entities/member.entity';

/** Matches the `InviteStatus` DB enum exactly — `cancelled` is withdrawal. */
export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'cancelled';

export interface HouseholdInvite {
  id: string;
  householdId: string;
  invitedById: string;
  inviteeEmail: string | null;
  inviteePhone: string | null;
  /** The secret. Returned to the INVITER so they can share the link. */
  token: string;
  status: InviteStatus;
  defaultRole: HouseholdRole;
  /** NULL = derive the accepted member's permission from `defaultRole`. */
  expiresAt: string;
  acceptedById: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

/**
 * What an invitee is shown BEFORE accepting.
 *
 * Deliberately thin. The holder of a token is, by definition, not yet a member
 * — so this must reveal nothing about the household's money. Just enough to
 * answer "who is asking me to join, and as what": the household name, who
 * invited them, and the role on offer.
 */
export interface InvitePreview {
  householdName: string;
  invitedByName: string | null;
  defaultRole: HouseholdRole;
  status: InviteStatus;
  expiresAt: string;
  /** True when the token is still usable — the only thing the UI branches on. */
  acceptable: boolean;
}

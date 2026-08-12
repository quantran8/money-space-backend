import type { Household } from '../../households/entities/household.entity';
import type { HouseholdInvite } from '../entities/invite.entity';

export const INVITES_REPOSITORY = Symbol('INVITES_REPOSITORY');

export interface AcceptInviteResult {
  householdId: string;
  memberId: string;
  /** True when the user was already a member — accepting again is a no-op. */
  alreadyMember: boolean;
}

export interface InvitesRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  createToken(): string;
  findInvitesByHousehold(householdId: string): Promise<HouseholdInvite[]>;
  findInviteById(
    householdId: string,
    inviteId: string,
  ): Promise<HouseholdInvite | undefined>;
  /**
   * Look an invite up by its token ALONE — no household scope, because the
   * invitee is not a member of anything yet and has nothing else to identify.
   */
  findInviteByToken(token: string): Promise<HouseholdInvite | undefined>;
  /** The household name + inviter name shown on the pre-accept screen. */
  findInviteContext(
    inviteId: string,
  ): Promise<{ householdName: string; invitedByName: string | null } | undefined>;
  insertInvite(invite: HouseholdInvite): Promise<void>;
  revokeInvite(inviteId: string): Promise<void>;
  /**
   * Join the household: upsert the profile, insert the member, and mark the
   * invite accepted — as ONE transaction. A half-applied accept would leave a
   * consumed token with no membership, locking the invitee out permanently.
   */
  acceptInvite(
    invite: HouseholdInvite,
    user: { id: string; email: string | null; fullName: string | null },
  ): Promise<AcceptInviteResult>;
}

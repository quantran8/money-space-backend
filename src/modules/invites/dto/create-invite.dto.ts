import type {
  HouseholdRole,
} from '../../members/entities/member.entity';

export interface CreateInviteDto {
  inviteeEmail?: string;
  inviteePhone?: string;
  /** Defaults to `partner` — the role the product is actually built around. */
  defaultRole?: HouseholdRole;
  /** Omit to derive the joined member's permission from `defaultRole`. */
  /** Days until the link stops working. Defaults to 14. */
  expiresInDays?: number;
}

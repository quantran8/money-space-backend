import type {} from '../../members/entities/member.entity';

export interface CreateInviteDto {
  inviteeEmail?: string;
  inviteePhone?: string;
  /** Days until the link stops working. Defaults to 14. */
  expiresInDays?: number;
}

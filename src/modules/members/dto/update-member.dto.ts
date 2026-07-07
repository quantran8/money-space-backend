import type { CreateMemberDto } from './create-member.dto';

export interface UpdateMemberDto extends Partial<CreateMemberDto> {}

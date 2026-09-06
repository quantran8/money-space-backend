import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { MembersService } from './members.service';
import type { CreateMemberDto } from './dto/create-member.dto';
import type { UpdateMemberDto } from './dto/update-member.dto';
import { RequireHouseholdCreator } from '../auth/decorators/require-household-creator.decorator';
import { CurrentMembership } from '../auth/decorators/current-membership.decorator';
import type { HouseholdMembership } from '../auth/guards/household-access.guard';

@Controller('households/:householdId/members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  listMembers(@Param('householdId') householdId: string) {
    return this.membersService.listMembers(householdId);
  }

  @Get(':memberId')
  getMember(
    @Param('householdId') householdId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.membersService.getMember(householdId, memberId);
  }

  @RequireHouseholdCreator()
  @Post()
  createMember(
    @Param('householdId') householdId: string,
    @Body() payload: CreateMemberDto,
  ) {
    return this.membersService.createMember(householdId, payload);
  }

  // Ungated: with role and permission gone this only edits a member's name,
  // email and initials — ordinary content, not a lifecycle change.
  @Patch(':memberId')
  updateMember(
    @Param('householdId') householdId: string,
    @Param('memberId') memberId: string,
    @Body() payload: UpdateMemberDto,
  ) {
    return this.membersService.updateMember(householdId, memberId, payload);
  }

  /**
   * Leaving — its own route, deliberately not `DELETE /members/:memberId`.
   *
   * That route is `@RequireHouseholdCreator()` because removing a member is a
   * lifecycle operation over the shared space. Leaving is not: it ends one
   * person's own access, nobody else's, and the household survives it intact.
   * Sharing the route would have meant either gating leaving behind the
   * creator (which made it impossible — a non-creator got "Only the member who
   * created this household can do that" for a question they did not ask) or
   * carving a self-exemption into the guard, where a URL that reads "delete
   * this member" would sometimes mean "leave" and sometimes not.
   *
   * Ungated beyond membership, and it takes no `:memberId`: the row it deletes
   * is the one the guard already resolved from the bearer token, so there is
   * no id in the request for a caller to point at someone else.
   *
   * Declared BEFORE `:memberId` — Nest matches in declaration order, and the
   * other way round `me` arrives as a member id and 404s.
   */
  @Delete('me')
  leaveHousehold(
    @Param('householdId') householdId: string,
    @CurrentMembership() membership?: HouseholdMembership,
  ) {
    return this.membersService.leaveHousehold(householdId, membership);
  }

  @RequireHouseholdCreator()
  @Delete(':memberId')
  deleteMember(
    @Param('householdId') householdId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.membersService.deleteMember(householdId, memberId);
  }
}

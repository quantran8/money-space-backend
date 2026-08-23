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

  @RequireHouseholdCreator()
  @Delete(':memberId')
  deleteMember(
    @Param('householdId') householdId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.membersService.deleteMember(householdId, memberId);
  }
}

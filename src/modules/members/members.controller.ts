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

@Controller('api/households/:householdId/members')
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

  @Post()
  createMember(
    @Param('householdId') householdId: string,
    @Body() payload: CreateMemberDto,
  ) {
    return this.membersService.createMember(householdId, payload);
  }

  @Patch(':memberId')
  updateMember(
    @Param('householdId') householdId: string,
    @Param('memberId') memberId: string,
    @Body() payload: UpdateMemberDto,
  ) {
    return this.membersService.updateMember(householdId, memberId, payload);
  }

  @Delete(':memberId')
  deleteMember(
    @Param('householdId') householdId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.membersService.deleteMember(householdId, memberId);
  }
}

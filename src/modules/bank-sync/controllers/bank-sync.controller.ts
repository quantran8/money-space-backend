import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentMembership } from '../../auth/decorators/current-membership.decorator';
import { RequirePremium } from '../../auth/decorators/require-premium.decorator';
import type { HouseholdMembership } from '../../auth/guards/household-access.guard';
import { BankCredentialsService } from '../services/bank-credentials.service';
import { BankEventsService } from '../services/bank-events.service';
import type { ResolveEventDto } from '../services/bank-events.service';
import { BankSourcesService } from '../services/bank-sources.service';
import type {
  CreateSourceDto,
  LinkSourceDto,
} from '../services/bank-sources.service';

/** Signed-in management of devices, sources and the inbox. */
@Controller('households/:householdId/bank-sync')
export class BankSyncController {
  constructor(
    private readonly credentials: BankCredentialsService,
    private readonly sources: BankSourcesService,
    private readonly events: BankEventsService,
  ) {}

  @RequirePremium('bank_sync')
  @Post('credentials')
  createCredential(
    @CurrentMembership() m: HouseholdMembership,
    @Body() body: { deviceLabel?: unknown },
  ) {
    return this.credentials.create(m.householdId, m.userId, body ?? {});
  }

  @Get('credentials')
  listCredentials(@CurrentMembership() m: HouseholdMembership) {
    return this.credentials.list(m.householdId, m.userId);
  }

  @Delete('credentials/:id')
  revokeCredential(
    @CurrentMembership() m: HouseholdMembership,
    @Param('id') id: string,
  ) {
    return this.credentials.revoke(m.householdId, m.userId, id);
  }

  @RequirePremium('bank_sync')
  @Post('sources')
  createSource(
    @CurrentMembership() m: HouseholdMembership,
    @Body() body: CreateSourceDto,
  ) {
    return this.sources.create(m.householdId, m.userId, body ?? {});
  }

  @Get('sources')
  listSources(@CurrentMembership() m: HouseholdMembership) {
    return this.sources.list(m.householdId);
  }

  @Patch('sources/:id')
  updateSource(
    @CurrentMembership() m: HouseholdMembership,
    @Param('id') id: string,
    @Body() body: { displayLabel?: unknown; status?: unknown },
  ) {
    return this.sources.update(m.householdId, id, body ?? {});
  }

  @RequirePremium('bank_sync')
  @Post('sources/:id/link')
  linkSource(
    @CurrentMembership() m: HouseholdMembership,
    @Param('id') id: string,
    @Body() body: LinkSourceDto,
  ) {
    return this.sources.link(m.householdId, m.userId, id, body ?? {});
  }

  @Delete('sources/:id/link')
  unlinkSource(
    @CurrentMembership() m: HouseholdMembership,
    @Param('id') id: string,
  ) {
    return this.sources.unlink(m.householdId, id);
  }

  @Get('events')
  listEvents(
    @CurrentMembership() m: HouseholdMembership,
    @Query() query: { status?: string; cursor?: string; limit?: string },
  ) {
    return this.events.list(m.householdId, query);
  }

  @Get('wallet-drift')
  walletDrift(@CurrentMembership() m: HouseholdMembership) {
    return this.events.walletDrift(m.householdId);
  }

  @Get('events/counts')
  countEvents(@CurrentMembership() m: HouseholdMembership) {
    return this.events.counts(m.householdId);
  }

  @Get('events/:id')
  getEvent(
    @CurrentMembership() m: HouseholdMembership,
    @Param('id') id: string,
  ) {
    return this.events.get(m.householdId, id);
  }

  @Post('events/:id/resolve')
  resolveEvent(
    @CurrentMembership() m: HouseholdMembership,
    @Param('id') id: string,
    @Body() body: ResolveEventDto,
  ) {
    return this.events.resolve(m.householdId, m.userId, id, body ?? {});
  }

  @Post('events/:id/reparse')
  reparseEvent(
    @CurrentMembership() m: HouseholdMembership,
    @Param('id') id: string,
  ) {
    return this.events.reparse(m.householdId, m.userId, id);
  }
}

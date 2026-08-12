import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SnapshotsService } from './snapshots.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';

/**
 * Snapshots are append-only: created deliberately here, never updated. There is
 * no PATCH and no DELETE by design — a snapshot that can be edited is not a
 * snapshot (§26).
 */
@Controller('api/households/:householdId/snapshots')
export class SnapshotsController {
  constructor(private readonly snapshotsService: SnapshotsService) {}

  @Get()
  list(@Param('householdId') householdId: string) {
    return this.snapshotsService.listSnapshots(householdId);
  }

  @Get(':snapshotId')
  getOne(
    @Param('householdId') householdId: string,
    @Param('snapshotId') snapshotId: string,
  ) {
    return this.snapshotsService.getSnapshot(householdId, snapshotId);
  }

  @RequireCapability('edit')
  @Post()
  create(
    @Param('householdId') householdId: string,
    @Body() payload: { note?: string; horizonDays?: number },
    @CurrentUser() user?: AuthUser,
  ) {
    return this.snapshotsService.createSnapshot(householdId, payload, user?.id);
  }
}

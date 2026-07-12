import { Controller, Get, Param } from '@nestjs/common';
import { SnapshotsService } from './snapshots.service';

// Snapshots are written automatically by the system (see SnapshotsService auto
// hooks) — there is no manual create endpoint. Read-only here.
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
}

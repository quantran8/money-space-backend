import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { SnapshotsService } from './snapshots.service';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';

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

  // Manual trigger now; a scheduled worker can call the same endpoint later.
  @RequireCapability('edit')
  @Post()
  create(
    @Param('householdId') householdId: string,
    @Body() dto: CreateSnapshotDto,
  ) {
    return this.snapshotsService.createSnapshot(householdId, dto);
  }
}

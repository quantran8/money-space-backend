import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { AssetsService } from './assets.service';
import type { CreateAssetDto } from './dto/create-asset.dto';
import type { UpdateAssetDto } from './dto/update-asset.dto';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';

@Controller('api/households/:householdId/assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get()
  listAssets(@Param('householdId') householdId: string) {
    return this.assetsService.listAssets(householdId);
  }

  @Get('summary')
  getAssetSummary(@Param('householdId') householdId: string) {
    return this.assetsService.getAssetSummary(householdId);
  }

  @Get('snapshots')
  getAssetSnapshots(@Param('householdId') householdId: string) {
    return this.assetsService.getAssetSnapshots(householdId);
  }

  @Get(':assetId')
  getAssetDetail(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.assetsService.getAssetDetail(householdId, assetId);
  }

  @Get(':assetId/valuations')
  getAssetValueHistoryPoints(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.assetsService.getAssetValueHistoryPoints(householdId, assetId);
  }

  @Get(':assetId/value-history')
  getAssetValueHistory(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.assetsService.getAssetValueHistory(householdId, assetId);
  }

  @RequireCapability('edit')
  @Post()
  createAsset(
    @Param('householdId') householdId: string,
    @Body() payload: CreateAssetDto,
  ) {
    return this.assetsService.createAsset(householdId, payload);
  }

  @RequireCapability('edit')
  @Patch(':assetId')
  updateAsset(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
    @Body() payload: UpdateAssetDto,
  ) {
    return this.assetsService.updateAsset(householdId, assetId, payload);
  }

  @RequireCapability('edit')
  @Delete(':assetId')
  deleteAsset(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.assetsService.deleteAsset(householdId, assetId);
  }
}

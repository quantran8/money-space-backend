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
  getAssetValuations(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.assetsService.getAssetValuations(householdId, assetId);
  }

  @Post()
  createAsset(
    @Param('householdId') householdId: string,
    @Body() payload: CreateAssetDto,
  ) {
    return this.assetsService.createAsset(householdId, payload);
  }

  @Patch(':assetId')
  updateAsset(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
    @Body() payload: UpdateAssetDto,
  ) {
    return this.assetsService.updateAsset(householdId, assetId, payload);
  }

  @Delete(':assetId')
  deleteAsset(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.assetsService.deleteAsset(householdId, assetId);
  }
}

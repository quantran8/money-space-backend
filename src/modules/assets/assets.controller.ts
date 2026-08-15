import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/entities/auth-user.entity';
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

  /**
   * How old the household's recorded values are (04 §12). A read — every
   * member may see how much to trust the numbers they are being shown.
   */
  @Get('data-freshness')
  getDataFreshness(@Param('householdId') householdId: string) {
    return this.assetsService.getDataFreshness(householdId);
  }

  /**
   * "I checked — nothing changed." Bumps freshness without writing a value.
   *
   * Declared BEFORE `:assetId` routes would matter for GETs; kept adjacent to
   * `data-freshness` because the two are one interaction in the UI.
   */
  @Post('confirm-unchanged')
  confirmAssetsUnchanged(
    @Param('householdId') householdId: string,
    @Body() payload: { assetIds?: string[] },
  ) {
    return this.assetsService.confirmAssetsUnchanged(householdId, payload);
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

  @Post('refresh-valuations')
  refreshMarketValuations(@Param('householdId') householdId: string) {
    return this.assetsService.refreshMarketValuations(householdId);
  }

  @Post()
  createAsset(
    @Param('householdId') householdId: string,
    @Body() payload: CreateAssetDto,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.assetsService.createAsset(householdId, payload, user?.id);
  }

  @Patch(':assetId')
  updateAsset(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
    @Body() payload: UpdateAssetDto,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.assetsService.updateAsset(householdId, assetId, payload, user?.id);
  }

  @Delete(':assetId')
  deleteAsset(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.assetsService.deleteAsset(householdId, assetId, user?.id);
  }
}

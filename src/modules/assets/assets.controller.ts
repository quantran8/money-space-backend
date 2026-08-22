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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentMembership } from '../auth/decorators/current-membership.decorator';
import type { AuthUser } from '../auth/entities/auth-user.entity';
import type { HouseholdMembership } from '../auth/guards/household-access.guard';
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
    @CurrentMembership() membership?: HouseholdMembership,
  ) {
    return this.assetsService.createAsset(
      householdId,
      payload,
      membership?.memberId,
    );
  }

  @Patch(':assetId')
  updateAsset(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
    @Body() payload: UpdateAssetDto,
  ) {
    return this.assetsService.updateAsset(householdId, assetId, payload);
  }

  /**
   * What deleting this asset would detach. A READ, called by the delete
   * confirmation before anything happens — the household is told what it is
   * about to lose while it can still say no.
   */
  @Get(':assetId/delete-impact')
  assetDeleteImpact(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.assetsService.getAssetDeleteImpact(householdId, assetId);
  }

  /**
   * `?cascade=true` is the household's answer to the 409 this returns while the
   * asset still backs anything. Never a default: the links it clears are the
   * ones that make a goal's progress mean what it means.
   */
  @Delete(':assetId')
  deleteAsset(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
    @Query('cascade') cascade?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.assetsService.deleteAsset(
      householdId,
      assetId,
      user?.id,
      cascade === 'true',
    );
  }
}

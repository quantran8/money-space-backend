import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { RawResponse } from '../../common/interceptors/raw-response.decorator';
import { AnalyticsService } from '../../common/analytics/analytics.service';
import { RequirePremium } from '../auth/decorators/require-premium.decorator';
import {
  EXPORT_DATASETS,
  ExportService,
  type ExportDataset,
  type ExportFormat,
} from './export.service';

/**
 * Taking the household's data out.
 *
 * `@RequirePremium('export_data')` is the only gate — the boolean already
 * existed in `PLAN_LIMITS` and in the guard from Phase 1; this is the route
 * that finally uses it.
 *
 * `@RawResponse()` because a downloaded file has to BE the file. The usual
 * `{ success, data }` envelope would make the CSV unopenable and the JSON
 * export a payload nested inside another one.
 */
@Controller('households/:householdId/export')
export class ExportController {
  constructor(
    private readonly exportService: ExportService,
    private readonly analytics: AnalyticsService,
  ) {}

  @RequirePremium('export_data')
  @RawResponse()
  // The browser must not hold a copy of somebody's finances, and a re-export
  // after an edit has to return the new data rather than the cached file.
  @Header('Cache-Control', 'no-store')
  @Get()
  async export(
    @Param('householdId') householdId: string,
    @Query('format') format: string | undefined,
    @Query('dataset') dataset: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const exportFormat = parseFormat(format);
    const exportDataset = parseDataset(dataset);

    const file = await this.exportService.export(
      householdId,
      exportFormat,
      exportDataset,
    );

    // After the file is built: a request refused by `@RequirePremium` never
    // reaches here, and that refusal is already a `paywall_hit`.
    this.analytics.capture(householdId, 'export_run', {
      format: exportFormat,
      dataset: exportDataset,
    });

    response.setHeader('Content-Type', file.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );

    return file.body;
  }
}

function parseFormat(raw: string | undefined): ExportFormat {
  if (raw === undefined || raw === 'json') return 'json';
  if (raw === 'csv') return 'csv';
  throw new BadRequestException(`Unsupported export format "${raw}"`);
}

function parseDataset(raw: string | undefined): ExportDataset | null {
  if (raw === undefined) return null;
  if ((EXPORT_DATASETS as string[]).includes(raw)) return raw as ExportDataset;
  throw new BadRequestException(`Unknown export dataset "${raw}"`);
}

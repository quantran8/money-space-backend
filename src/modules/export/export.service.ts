import { Inject, Injectable } from '@nestjs/common';
import { toCsv, type CsvValue } from './domain/csv';
import {
  EXPORT_REPOSITORY,
  type ExportRepository,
} from './repositories/export.repository.interface';

/** What the household can ask for. */
export type ExportFormat = 'json' | 'csv';

/** Which records a CSV file holds. JSON always carries all of them. */
export type ExportDataset =
  | 'assets'
  | 'money-events'
  | 'cashflow-events'
  | 'goals'
  | 'debts';

export const EXPORT_DATASETS: ExportDataset[] = [
  'assets',
  'money-events',
  'cashflow-events',
  'goals',
  'debts',
];

export interface ExportFile {
  filename: string;
  contentType: string;
  body: string;
}

/** ISO date only — the time of day is noise in a spreadsheet. */
function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function isoDateTime(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * The household's own data, back out again.
 *
 * JSON is the complete record and CSV is one dataset per file — see
 * `memory/data-export.md` for why both exist and why neither is streamed.
 */
@Injectable()
export class ExportService {
  constructor(
    @Inject(EXPORT_REPOSITORY)
    private readonly exportRepository: ExportRepository,
  ) {}

  async export(
    householdId: string,
    format: ExportFormat,
    dataset: ExportDataset | null,
    now = new Date(),
  ): Promise<ExportFile> {
    return format === 'csv'
      ? this.exportCsv(householdId, dataset ?? 'money-events', now)
      : this.exportJson(householdId, now);
  }

  /**
   * Everything, in one file, with the relationships intact.
   *
   * The whole household is held in memory: a file the household downloads has
   * to be complete before it is a record of anything, and the biggest realistic
   * household is a few thousand rows. If that stops being true, this is the
   * method that grows a cursor.
   */
  private async exportJson(
    householdId: string,
    now: Date,
  ): Promise<ExportFile> {
    const [household, assets, moneyEvents, cashflowEvents, goals, debts] =
      await Promise.all([
        this.exportRepository.assertHousehold(householdId),
        this.exportRepository.findAssets(householdId),
        this.exportRepository.findMoneyEvents(householdId),
        this.exportRepository.findCashflowEvents(householdId),
        this.exportRepository.findGoals(householdId),
        this.exportRepository.findDebts(householdId),
      ]);

    const payload = {
      // Stamped so a file found on a disk in a year says what it is and when it
      // was taken, without the household having to remember.
      exportedAt: now.toISOString(),
      formatVersion: 1,
      household: {
        id: household.id,
        name: household.name,
        currency: household.currency,
        createdAt: household.createdAt.toISOString(),
      },
      assets: assets.map((asset) => ({
        ...asset,
        valueUpdatedAt: isoDateTime(asset.valueUpdatedAt),
        createdAt: asset.createdAt.toISOString(),
      })),
      moneyEvents: moneyEvents.map((event) => ({
        ...event,
        eventDate: isoDate(event.eventDate),
        createdAt: event.createdAt.toISOString(),
      })),
      cashflowEvents: cashflowEvents.map((event) => ({
        ...event,
        expectedDate: isoDate(event.expectedDate),
        recurrenceEndDate: isoDate(event.recurrenceEndDate),
      })),
      goals: goals.map((goal) => ({
        ...goal,
        targetDate: isoDate(goal.targetDate),
        createdAt: goal.createdAt.toISOString(),
      })),
      debts: debts.map((debt) => ({
        ...debt,
        borrowedAt: isoDate(debt.borrowedAt),
        expectedFinalDueDate: isoDate(debt.expectedFinalDueDate),
      })),
      counts: {
        assets: assets.length,
        moneyEvents: moneyEvents.length,
        cashflowEvents: cashflowEvents.length,
        goals: goals.length,
        debts: debts.length,
      },
    };

    return {
      filename: this.filename(household.name, 'json', now),
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(payload, null, 2),
    };
  }

  private async exportCsv(
    householdId: string,
    dataset: ExportDataset,
    now: Date,
  ): Promise<ExportFile> {
    const household = await this.exportRepository.assertHousehold(householdId);
    const sheet = await this.buildSheet(householdId, dataset);

    return {
      filename: this.filename(`${household.name}-${dataset}`, 'csv', now),
      contentType: 'text/csv; charset=utf-8',
      body: toCsv(sheet.headers, sheet.rows),
    };
  }

  private async buildSheet(
    householdId: string,
    dataset: ExportDataset,
  ): Promise<{ headers: string[]; rows: CsvValue[][] }> {
    // Headers are English machine names, not Vietnamese labels: a spreadsheet
    // that gets re-imported has to match on something stable, and the client
    // owns all display copy anyway.
    switch (dataset) {
      case 'assets': {
        const rows = await this.exportRepository.findAssets(householdId);
        return {
          headers: [
            'name',
            'type',
            'valuation_mode',
            'current_value',
            'currency',
            'liquidity',
            'status',
            'symbol',
            'quantity',
            'unit',
            'value_updated_at',
            'created_at',
            'note',
          ],
          rows: rows.map((row) => [
            row.name,
            row.type,
            row.valuationMode,
            row.currentValue,
            row.currency,
            row.liquidity,
            row.status,
            row.symbol,
            row.quantity,
            row.unit,
            isoDateTime(row.valueUpdatedAt),
            row.createdAt.toISOString(),
            row.note,
          ]),
        };
      }

      case 'money-events': {
        const rows = await this.exportRepository.findMoneyEvents(householdId);
        return {
          headers: [
            'event_date',
            'event_type',
            'direction',
            'description',
            'category',
            'amount',
            'fee_amount',
            'currency',
            'from_asset',
            'to_asset',
            'status',
          ],
          rows: rows.map((row) => [
            isoDate(row.eventDate),
            row.eventType,
            row.direction,
            row.description,
            row.categoryName,
            row.amount,
            row.feeAmount,
            row.currency,
            row.fromAssetName,
            row.toAssetName,
            row.status,
          ]),
        };
      }

      case 'cashflow-events': {
        const rows =
          await this.exportRepository.findCashflowEvents(householdId);
        return {
          headers: [
            'name',
            'direction',
            'amount',
            'expected_date',
            'recurrence',
            'recurrence_end_date',
            'requirement',
            'certainty',
            'category',
            'status',
            'note',
          ],
          rows: rows.map((row) => [
            row.name,
            row.direction,
            row.amount,
            isoDate(row.expectedDate),
            row.recurrence,
            isoDate(row.recurrenceEndDate),
            row.requirement,
            row.certainty,
            row.categoryName,
            row.status,
            row.note,
          ]),
        };
      }

      case 'goals': {
        const rows = await this.exportRepository.findGoals(householdId);
        return {
          headers: [
            'name',
            'category',
            'target_amount',
            'target_date',
            'priority',
            'status',
            'created_at',
            'note',
          ],
          rows: rows.map((row) => [
            row.name,
            row.category,
            row.targetAmount,
            isoDate(row.targetDate),
            row.priority,
            row.status,
            row.createdAt.toISOString(),
            row.note,
          ]),
        };
      }

      case 'debts': {
        const rows = await this.exportRepository.findDebts(householdId);
        return {
          headers: [
            'name',
            'lender_type',
            'lender_name',
            'original_amount',
            'outstanding_amount',
            'currency',
            'borrowed_at',
            'expected_final_due_date',
            'status',
            'note',
          ],
          rows: rows.map((row) => [
            row.name,
            row.lenderType,
            row.lenderName,
            row.originalAmount,
            row.outstandingAmount,
            row.currency,
            isoDate(row.borrowedAt),
            isoDate(row.expectedFinalDueDate),
            row.status,
            row.note,
          ]),
        };
      }
    }
  }

  /**
   * `oursight-<household>-<date>.<ext>`, ASCII-only.
   *
   * The household name is transliterated rather than sent as-is: a filename in
   * `Content-Disposition` travels through headers that are latin-1, and
   * "Gia đình Minh" would arrive mangled or split the header.
   */
  private filename(name: string, extension: string, now: Date): string {
    const slug = name
      .normalize('NFD')
      // Strip combining marks, then đ/Đ which is a distinct letter and survives
      // decomposition.
      .replace(/[̀-ͯ]/g, '')
      .replace(/[đĐ]/g, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

    const date = now.toISOString().slice(0, 10);
    return `oursight-${slug || 'household'}-${date}.${extension}`;
  }
}

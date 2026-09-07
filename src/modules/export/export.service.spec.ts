import { ExportService } from './export.service';
import { UTF8_BOM } from './domain/csv';

const NOW = new Date('2026-09-07T03:00:00.000Z');

function setup(over: Record<string, unknown> = {}) {
  const exportRepository = {
    assertHousehold: jest.fn(async () => ({
      id: 'hh-1',
      name: 'Gia đình Minh',
      currency: 'VND',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    })),
    findAssets: jest.fn(async () => []),
    findMoneyEvents: jest.fn(async () => []),
    findCashflowEvents: jest.fn(async () => []),
    findGoals: jest.fn(async () => []),
    findDebts: jest.fn(async () => []),
    ...over,
  } as never;

  return {
    service: new ExportService(exportRepository),
    exportRepository: exportRepository as Record<string, jest.Mock>,
  };
}

const asset = {
  name: 'VCB',
  type: 'bank_account',
  valuationMode: 'manual',
  currentValue: 5_000_000,
  currency: 'VND',
  liquidity: 'usable_now',
  status: 'active',
  symbol: null,
  quantity: null,
  unit: null,
  note: null,
  valueUpdatedAt: new Date('2026-09-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-05T00:00:00.000Z'),
};

describe('ExportService — JSON', () => {
  it('carries every dataset and a stamp of when it was taken', async () => {
    const { service } = setup({ findAssets: jest.fn(async () => [asset]) });

    const file = await service.export('hh-1', 'json', null, NOW);
    const payload = JSON.parse(file.body);

    expect(file.contentType).toBe('application/json; charset=utf-8');
    expect(payload.exportedAt).toBe(NOW.toISOString());
    expect(payload.formatVersion).toBe(1);
    expect(payload.household.name).toBe('Gia đình Minh');
    expect(payload.assets).toHaveLength(1);
    expect(payload.counts).toEqual({
      assets: 1,
      moneyEvents: 0,
      cashflowEvents: 0,
      goals: 0,
      debts: 0,
    });
  });

  // A Date does not survive JSON as anything readable, and a spreadsheet or a
  // later import has to be able to parse what comes out.
  it('renders every date as an ISO string', async () => {
    const { service } = setup({ findAssets: jest.fn(async () => [asset]) });

    const payload = JSON.parse(
      (await service.export('hh-1', 'json', null, NOW)).body,
    );

    expect(payload.assets[0].valueUpdatedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(payload.assets[0].createdAt).toBe('2026-01-05T00:00:00.000Z');
  });

  it('exports an empty household without failing', async () => {
    const { service } = setup();

    const payload = JSON.parse(
      (await service.export('hh-1', 'json', null, NOW)).body,
    );

    expect(payload.assets).toEqual([]);
    expect(payload.counts.assets).toBe(0);
  });
});

describe('ExportService — CSV', () => {
  it('writes the requested dataset only', async () => {
    const { service, exportRepository } = setup({
      findGoals: jest.fn(async () => [
        {
          name: 'Mua xe',
          category: 'vehicle',
          targetAmount: 300_000_000,
          targetDate: new Date('2027-06-01T00:00:00.000Z'),
          priority: 'high',
          status: 'active',
          note: null,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
        },
      ]),
    });

    const file = await service.export('hh-1', 'csv', 'goals', NOW);

    expect(file.contentType).toBe('text/csv; charset=utf-8');
    expect(file.body).toContain('name,category,target_amount');
    expect(file.body).toContain('Mua xe,vehicle,300000000,2027-06-01');
    expect(exportRepository.findAssets).not.toHaveBeenCalled();
  });

  it('leads with a BOM so Excel reads Vietnamese names', async () => {
    const { service } = setup({ findAssets: jest.fn(async () => [asset]) });

    const file = await service.export('hh-1', 'csv', 'assets', NOW);

    expect(file.body.startsWith(UTF8_BOM)).toBe(true);
  });

  it('defaults to money events when no dataset is named', async () => {
    const { service, exportRepository } = setup();

    await service.export('hh-1', 'csv', null, NOW);

    expect(exportRepository.findMoneyEvents).toHaveBeenCalled();
  });

  it('writes a header-only file for an empty dataset', async () => {
    const { service } = setup();

    const file = await service.export('hh-1', 'csv', 'debts', NOW);

    expect(file.body).toBe(
      `${UTF8_BOM}name,lender_type,lender_name,original_amount,` +
        `outstanding_amount,currency,borrowed_at,expected_final_due_date,` +
        `status,note\r\n`,
    );
  });
});

describe('ExportService — filename', () => {
  // Content-Disposition travels through a latin-1 header, so "Gia đình Minh"
  // would arrive mangled or split the header.
  it('transliterates the household name to ASCII', async () => {
    const { service } = setup();

    const file = await service.export('hh-1', 'json', null, NOW);

    expect(file.filename).toBe('oursight-gia-dinh-minh-2026-09-07.json');
    expect(file.filename).toMatch(/^[\x20-\x7e]+$/);
  });

  it('names the dataset in a CSV filename', async () => {
    const { service } = setup();

    const file = await service.export('hh-1', 'csv', 'assets', NOW);

    expect(file.filename).toBe('oursight-gia-dinh-minh-assets-2026-09-07.csv');
  });

  it('falls back when the name transliterates to nothing', async () => {
    const { service } = setup({
      assertHousehold: jest.fn(async () => ({
        id: 'hh-1',
        name: '。。。',
        currency: 'VND',
        createdAt: NOW,
      })),
    });

    const file = await service.export('hh-1', 'json', null, NOW);

    expect(file.filename).toBe('oursight-household-2026-09-07.json');
  });
});

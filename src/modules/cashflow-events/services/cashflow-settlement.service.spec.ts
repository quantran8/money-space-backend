import { BadRequestException, ConflictException } from '@nestjs/common';
import type { CashflowEvent } from '../entities/cashflow-event.entity';
import type { SettlementEvidence } from '../domain/settlement';
import type { SettlementMoneyEvent } from '../repositories/prisma-settlement.repository';
import { CashflowSettlementService } from './cashflow-settlement.service';

const M = 1_000_000;

const salary: CashflowEvent = {
  id: 'cf-1',
  householdId: 'hh-1',
  name: 'Luong',
  categoryId: 'cat',
  amount: 30 * M,
  direction: 'incoming',
  expectedDate: '2026-10-25',
  recurrence: 'monthly',
  recurrenceEndDate: null,
  requirement: null,
  certainty: 'confirmed',
  status: 'expected',
  attentionLevel: 'normal',
  debtId: null,
  settlementAssetId: 'w-1',
  lastCompletedAt: null,
  lastCompletedById: null,
  lastCompletedAmount: null,
  lastCompletedAssetId: null,
} as CashflowEvent;

const bankMoney: SettlementMoneyEvent = {
  id: 'me-bank',
  householdId: 'hh-1',
  amount: 32 * M,
  direction: 'inflow',
  eventDate: '2026-10-25',
  fromAssetId: null,
  toAssetId: 'w-1',
  cashflowEventId: null,
  occurrenceDate: null,
  settledVia: null,
  origin: 'bank_notification',
  notificationEventId: 'evt-1',
  note: 'LUONG T10',
};

function evidence(over: Partial<SettlementEvidence>): SettlementEvidence {
  return {
    moneyEventId: 'me-x',
    occurrenceDate: '2026-09-25',
    amount: 30 * M,
    assetId: 'w-1',
    settledAt: '2026-09-25T03:00:00.000Z',
    settledById: 'u-1',
    settledVia: 'manual_link',
    notificationEventId: null,
    ...over,
  };
}

function setup(opts: {
  event?: Partial<CashflowEvent>;
  money?: Partial<SettlementMoneyEvent>;
  settlements?: SettlementEvidence[];
}) {
  let stored = { ...salary, ...opts.event };
  const money = { ...bankMoney, ...opts.money };
  const updateCashflowEvent = jest.fn((_id: string, next: CashflowEvent) => {
    stored = next;
    return Promise.resolve();
  });
  const cashflowEvents = {
    findCashflowEventById: jest.fn(() => Promise.resolve(stored)),
    updateCashflowEvent,
  };
  const repo = {
    lockCashflowEvent: jest.fn(() => Promise.resolve()),
    lockMoneyEvent: jest.fn(() => Promise.resolve(money)),
    findMoneyEvent: jest.fn(() => Promise.resolve(money)),
    listSettlements: jest.fn(() => Promise.resolve(opts.settlements ?? [])),
    markSettled: jest.fn(() => Promise.resolve()),
    clearSettlement: jest.fn(() => Promise.resolve()),
  };
  const moneyEvents = {
    relinkCashflow: jest.fn(() => Promise.resolve()),
    deleteMoneyEvent: jest.fn(() => Promise.resolve()),
  };
  const cache = {
    runInTransactionAndInvalidate: jest.fn(
      (_hh: string, work: () => Promise<unknown>) => work(),
    ),
  };
  const service = new CashflowSettlementService(
    cashflowEvents as never,
    repo as never,
    moneyEvents as never,
    cache as never,
  );
  return { service, repo, moneyEvents, updateCashflowEvent, current: () => stored };
}

describe('CashflowSettlementService.settleExisting', () => {
  it('S05/S06: links bank money to the pending occurrence without a new money event', async () => {
    const { service, repo, moneyEvents, current } = setup({});

    const result = await service.settleExisting(
      'hh-1',
      'cf-1',
      'me-bank',
      'manual_link',
      'u-1',
    );

    expect(moneyEvents.relinkCashflow).toHaveBeenCalledWith('hh-1', 'me-bank', {
      cashflowEventId: 'cf-1',
      debtId: null,
    });
    expect(repo.markSettled).toHaveBeenCalledWith(
      'me-bank',
      expect.objectContaining({
        occurrenceDate: '2026-10-25',
        settledVia: 'manual_link',
      }),
    );
    expect(result.advancedTo).toBe('2026-11-25');
    // S07: actual differs, the plan for November does not.
    expect(current().lastCompletedAmount).toBe(32 * M);
    expect(current().amount).toBe(30 * M);
  });

  it('refuses money already linked elsewhere', async () => {
    const { service } = setup({ money: { cashflowEventId: 'cf-2' } });
    await expect(
      service.settleExisting('hh-1', 'cf-1', 'me-bank', 'manual_link', 'u-1'),
    ).rejects.toThrow(ConflictException);
  });

  it('refuses the wrong direction', async () => {
    const { service } = setup({ money: { direction: 'outflow' } });
    await expect(
      service.settleExisting('hh-1', 'cf-1', 'me-bank', 'manual_link', 'u-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('S15: a concurrent settle of the same occurrence surfaces as 409', async () => {
    const { service, repo } = setup({});
    repo.markSettled.mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      service.settleExisting('hh-1', 'cf-1', 'me-bank', 'manual_link', 'u-1'),
    ).rejects.toThrow(ConflictException);
  });
});

describe('CashflowSettlementService.unsettle', () => {
  it('S14: reopens the latest occurrence and keeps the bank money', async () => {
    const { service, repo, moneyEvents, current } = setup({
      event: { expectedDate: '2026-11-25' },
      money: { cashflowEventId: 'cf-1', occurrenceDate: '2026-10-25', settledVia: 'manual_link' },
      settlements: [
        evidence({ moneyEventId: 'me-bank', occurrenceDate: '2026-10-25' }),
        evidence({ moneyEventId: 'me-old', settledById: 'u-2' }),
      ],
    });

    await service.unsettle('hh-1', 'me-bank');

    expect(current().expectedDate).toBe('2026-10-25');
    expect(current().lastCompletedById).toBe('u-2');
    expect(repo.clearSettlement).toHaveBeenCalledWith('me-bank');
    expect(moneyEvents.deleteMoneyEvent).not.toHaveBeenCalled();
  });

  it('only the most recent occurrence can be reopened', async () => {
    const { service } = setup({
      money: { cashflowEventId: 'cf-1', occurrenceDate: '2026-09-25', settledVia: 'manual_link' },
      settlements: [
        evidence({ moneyEventId: 'me-new', occurrenceDate: '2026-10-25' }),
        evidence({ moneyEventId: 'me-bank' }),
      ],
    });
    await expect(service.unsettle('hh-1', 'me-bank')).rejects.toThrow(
      ConflictException,
    );
  });

  it('a manual completion is undone by deleting, not unlinking', async () => {
    const { service } = setup({
      money: { cashflowEventId: 'cf-1', occurrenceDate: '2026-10-25', settledVia: 'manual_complete' },
    });
    await expect(service.unsettle('hh-1', 'me-bank')).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('CashflowSettlementService.replaceManualWithBank', () => {
  it('S08: deletes the manual money event and settles the same occurrence with the bank one', async () => {
    const { service, repo, moneyEvents, current } = setup({
      event: { expectedDate: '2026-11-25' },
      settlements: [
        evidence({
          moneyEventId: 'me-manual',
          occurrenceDate: '2026-10-25',
          settledVia: 'manual_complete',
        }),
      ],
    });

    await service.replaceManualWithBank('hh-1', 'cf-1', 'me-bank', 'u-1');

    expect(repo.clearSettlement).toHaveBeenCalledWith('me-manual');
    expect(moneyEvents.deleteMoneyEvent).toHaveBeenCalledWith('hh-1', 'me-manual');
    expect(repo.markSettled).toHaveBeenCalledWith(
      'me-bank',
      expect.objectContaining({ occurrenceDate: '2026-10-25' }),
    );
    expect(current().expectedDate).toBe('2026-11-25');
  });

  it('refuses when the latest occurrence was not completed by hand', async () => {
    const { service } = setup({
      settlements: [evidence({ settledVia: 'auto_note', notificationEventId: 'evt-0' })],
    });
    await expect(
      service.replaceManualWithBank('hh-1', 'cf-1', 'me-bank', 'u-1'),
    ).rejects.toThrow(ConflictException);
  });
});

import { BadRequestException, ConflictException } from '@nestjs/common';
import { CashflowEventsService } from './cashflow-events.service';
import type { CashflowEvent } from './entities/cashflow-event.entity';

/**
 * The §18 completion semantics, which are the subtlest part of the v3.1 model:
 * a one-off closes, a recurring series ADVANCES and stays open. Get this wrong
 * and either a bill disappears from the forecast or it charges twice.
 */
describe('CashflowEventsService — completion (§18)', () => {
  const base: CashflowEvent = {
    id: 'cf-1',
    householdId: 'hh-1',
    name: 'Tien nha',
    amount: 12_000_000,
    direction: 'outgoing',
    expectedDate: '2026-08-15',
    recurrence: 'once',
    recurrenceEndDate: null,
    requirement: 'required',
    certainty: 'confirmed',
    status: 'expected',
    attentionLevel: 'normal',
    visibilityLevel: 'detail',
    ownerMemberId: null,
    privacyOwnerMemberId: null,
    debtId: null,
    financialGoalId: null,
    plannedAssetId: null,
    note: '',
    lastCompletedAt: null,
    lastCompletedById: null,
    lastCompletedAmount: null,
    lastCompletedAssetId: null,
  };

  function setup(event: Partial<CashflowEvent> = {}) {
    const stored = { ...base, ...event };
    const updateCashflowEvent = jest.fn(async () => undefined);
    const repository = {
      findCashflowEventById: jest.fn(async () => stored),
      updateCashflowEvent,
      createId: () => 'new-id',
      assertHousehold: jest.fn(async () => ({}) as never),
    } as never;
    const prisma = {
      runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
    } as never;
    const createMoneyEvent = jest.fn(async () => ({ id: 'me-1' }));
    const moneyEvents = { createMoneyEvent } as never;

    const service = new CashflowEventsService(repository, prisma, moneyEvents);
    return { service, updateCashflowEvent, createMoneyEvent };
  }

  it('closes a one-off and leaves its date alone', async () => {
    const { service, updateCashflowEvent } = setup({ recurrence: 'once' });

    const result = await service.completeCashflowEvent('hh-1', 'cf-1');

    expect(result.event.status).toBe('completed');
    expect(result.event.expectedDate).toBe('2026-08-15');
    expect(result.advancedTo).toBeNull();
    expect(updateCashflowEvent).toHaveBeenCalledTimes(1);
  });

  // The core of the recurrence model: the record is a live series, not history.
  it('ADVANCES a recurring event and keeps it expected', async () => {
    const { service } = setup({ recurrence: 'monthly' });

    const result = await service.completeCashflowEvent('hh-1', 'cf-1');

    expect(result.event.expectedDate).toBe('2026-09-15');
    expect(result.event.status).toBe('expected');
    expect(result.advancedTo).toBe('2026-09-15');
  });

  it('clamps the advance to month length', async () => {
    const { service } = setup({
      recurrence: 'monthly',
      expectedDate: '2026-01-31',
    });

    const result = await service.completeCashflowEvent('hh-1', 'cf-1');

    expect(result.event.expectedDate).toBe('2026-02-28');
  });

  it('closes the series when the next occurrence is past its end date', async () => {
    const { service } = setup({
      recurrence: 'monthly',
      expectedDate: '2026-08-15',
      recurrenceEndDate: '2026-09-01',
    });

    const result = await service.completeCashflowEvent('hh-1', 'cf-1');

    expect(result.event.status).toBe('completed');
    // The date stays on the last real occurrence rather than jumping past the end.
    expect(result.event.expectedDate).toBe('2026-08-15');
  });

  it('records the completion details', async () => {
    const { service } = setup({ recurrence: 'once' });

    const result = await service.completeCashflowEvent('hh-1', 'cf-1', {
      amount: 11_500_000,
      assetId: 'asset-vcb',
    });

    expect(result.event.lastCompletedAmount).toBe(11_500_000);
    expect(result.event.lastCompletedAssetId).toBe('asset-vcb');
    expect(result.event.lastCompletedAt).toBeTruthy();
  });

  it('creates an outgoing completion as payment_paid debiting the wallet', async () => {
    const { service, createMoneyEvent } = setup({ direction: 'outgoing' });

    await service.completeCashflowEvent('hh-1', 'cf-1', {
      assetId: 'asset-vcb',
    });

    expect(createMoneyEvent).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({
        type: 'payment_paid',
        fromAssetId: 'asset-vcb',
        toAssetId: undefined,
        cashflowEventId: 'cf-1',
      }),
    );
  });

  it('creates an incoming completion as income crediting the wallet', async () => {
    const { service, createMoneyEvent } = setup({
      direction: 'incoming',
      requirement: null,
    });

    await service.completeCashflowEvent('hh-1', 'cf-1', {
      assetId: 'asset-vcb',
    });

    expect(createMoneyEvent).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({
        type: 'income',
        toAssetId: 'asset-vcb',
        fromAssetId: undefined,
      }),
    );
  });

  it('refuses to complete an already-completed event', async () => {
    const { service, createMoneyEvent } = setup({ status: 'completed' });

    await expect(service.completeCashflowEvent('hh-1', 'cf-1')).rejects.toThrow(
      ConflictException,
    );
    expect(createMoneyEvent).not.toHaveBeenCalled();
  });

  // A double-tap must not advance a monthly series two months — that would
  // silently drop a month of obligations from the forecast.
  it('refuses to re-complete an occurrence the series has moved past', async () => {
    const { service } = setup({
      recurrence: 'monthly',
      expectedDate: '2026-09-15',
      lastCompletedAt: '2026-08-15T00:00:00.000Z',
    });

    await expect(
      service.completeCashflowEvent('hh-1', 'cf-1', {
        occurrenceDate: '2026-08-15',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects a negative completion amount', async () => {
    const { service } = setup();

    await expect(
      service.completeCashflowEvent('hh-1', 'cf-1', { amount: -1 }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('CashflowEventsService — validation (§18, §30)', () => {
  function setup() {
    const inserted: CashflowEvent[] = [];
    const repository = {
      createId: () => 'cf-new',
      insertCashflowEvent: jest.fn(async (e: CashflowEvent) => {
        inserted.push(e);
      }),
      assertHousehold: jest.fn(async () => ({}) as never),
    } as never;
    const service = new CashflowEventsService(
      repository,
      {} as never,
      {} as never,
    );
    return { service, inserted };
  }

  const valid = {
    name: 'Luong',
    amount: 30_000_000,
    direction: 'incoming' as const,
    expectedDate: '2026-08-20',
  };

  // Incoming money has no "requirement" — nothing obliges it to arrive.
  it('forces requirement to null for incoming', async () => {
    const { service, inserted } = setup();

    await service.createCashflowEvent('hh-1', {
      ...valid,
      requirement: 'required',
    });

    expect(inserted[0].requirement).toBeNull();
  });

  // Conservative default: assume an unspecified outgoing IS an obligation, so
  // obligation coverage doesn't quietly overstate how safe the household is.
  it('defaults outgoing requirement to required', async () => {
    const { service, inserted } = setup();

    await service.createCashflowEvent('hh-1', {
      ...valid,
      direction: 'outgoing',
    });

    expect(inserted[0].requirement).toBe('required');
  });

  it('rejects a recurrence ending before it starts', async () => {
    const { service } = setup();

    await expect(
      service.createCashflowEvent('hh-1', {
        ...valid,
        recurrence: 'monthly',
        recurrenceEndDate: '2026-08-01',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  /*
   * The two tests that stood here pinned the rule that a `private` event had to
   * name whose privacy it was. Neither the level nor the owner column exists
   * now — nothing is withheld from the shared picture, so there is no privacy
   * to own.
   */
  it.each([
    ['blank name', { name: '  ' }],
    ['negative amount', { amount: -1 }],
  ])('rejects %s', async (_label, patch) => {
    const { service } = setup();

    await expect(
      service.createCashflowEvent('hh-1', { ...valid, ...patch }),
    ).rejects.toThrow(BadRequestException);
  });
});

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
      deleteCashflowEvent: jest.fn(async () => undefined),
      unlinkCashflowEventFromMoneyEvents: jest.fn(async () => undefined),
      createId: () => 'new-id',
      assertHousehold: jest.fn(async () => ({}) as never),
    } as never;
    const prisma = {
      runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
    } as never;
    const createMoneyEvent = jest.fn(async () => ({ id: 'me-1' }));
    // `category` is an FK now, so the service resolves an id through
    // MoneyEventsService before every create/update.
    const systemCategoryId = jest.fn(async () => 'cat-other');
    const resolveCategoryIdOrThrow = jest.fn(async (_hh: string, id: string) => id);
    const moneyEvents = {
      createMoneyEvent,
      systemCategoryId,
      resolveCategoryIdOrThrow,
    } as never;
    // A usable_now wallet — the only kind that can settle an event.
    const getAssetDetail = jest.fn(async () => ({
      id: 'asset-vcb',
      type: 'bank_account',
      liquidity: 'usable_now',
    }));
    const assets = { getAssetDetail } as never;

    const service = new CashflowEventsService(
      repository,
      prisma,
      moneyEvents,
      assets,
    );
    return {
      service,
      repository,
      updateCashflowEvent,
      createMoneyEvent,
      getAssetDetail,
    };
  }

  it('closes a one-off and leaves its date alone', async () => {
    const { service, updateCashflowEvent } = setup({ recurrence: 'once' });

    const result = await service.completeCashflowEvent('hh-1', 'cf-1', {
      assetId: 'asset-vcb',
    });

    expect(result.event.status).toBe('completed');
    expect(result.event.expectedDate).toBe('2026-08-15');
    expect(result.advancedTo).toBeNull();
    expect(updateCashflowEvent).toHaveBeenCalledTimes(1);
  });

  // The core of the recurrence model: the record is a live series, not history.
  it('ADVANCES a recurring event and keeps it expected', async () => {
    const { service } = setup({ recurrence: 'monthly' });

    const result = await service.completeCashflowEvent('hh-1', 'cf-1', {
      assetId: 'asset-vcb',
    });

    expect(result.event.expectedDate).toBe('2026-09-15');
    expect(result.event.status).toBe('expected');
    expect(result.advancedTo).toBe('2026-09-15');
  });

  it('clamps the advance to month length', async () => {
    const { service } = setup({
      recurrence: 'monthly',
      expectedDate: '2026-01-31',
    });

    const result = await service.completeCashflowEvent('hh-1', 'cf-1', {
      assetId: 'asset-vcb',
    });

    expect(result.event.expectedDate).toBe('2026-02-28');
  });

  it('closes the series when the next occurrence is past its end date', async () => {
    const { service } = setup({
      recurrence: 'monthly',
      expectedDate: '2026-08-15',
      recurrenceEndDate: '2026-09-01',
    });

    const result = await service.completeCashflowEvent('hh-1', 'cf-1', {
      assetId: 'asset-vcb',
    });

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

  // The bug this guards: with no wallet on either side `applyWalletEffects`
  // debits and credits nothing, so the event looked settled and no balance
  // moved anywhere.
  it('refuses to complete when no wallet is given or stored', async () => {
    const { service, createMoneyEvent } = setup({ settlementAssetId: null });

    await expect(service.completeCashflowEvent('hh-1', 'cf-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(createMoneyEvent).not.toHaveBeenCalled();
  });

  it('falls back to the wallet chosen when the event was created', async () => {
    const { service, createMoneyEvent } = setup({
      direction: 'outgoing',
      settlementAssetId: 'asset-stored',
    });

    await service.completeCashflowEvent('hh-1', 'cf-1');

    expect(createMoneyEvent).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({ fromAssetId: 'asset-stored' }),
    );
  });

  it('prefers the wallet passed at completion over the stored one', async () => {
    const { service, createMoneyEvent } = setup({
      direction: 'outgoing',
      settlementAssetId: 'asset-stored',
    });

    await service.completeCashflowEvent('hh-1', 'cf-1', {
      assetId: 'asset-picked',
    });

    expect(createMoneyEvent).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({ fromAssetId: 'asset-picked' }),
    );
  });

  it('names the completion after the event when no note is typed', async () => {
    const { service, createMoneyEvent } = setup({
      name: 'Tien dien thang 9',
      settlementAssetId: 'asset-stored',
    });

    await service.completeCashflowEvent('hh-1', 'cf-1', {});

    expect(createMoneyEvent).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({ note: 'Tien dien thang 9' }),
    );
  });

  it('prefers a typed note over the event name', async () => {
    const { service, createMoneyEvent } = setup({
      name: 'Tien dien thang 9',
      settlementAssetId: 'asset-stored',
    });

    await service.completeCashflowEvent('hh-1', 'cf-1', {
      note: '  Tra bu ky truoc  ',
    });

    expect(createMoneyEvent).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({ note: 'Tra bu ky truoc' }),
    );
  });

  // Only flexible money settles an event — see memory/assets.md.
  it('refuses a wallet that is not counted as flexible money', async () => {
    const { service, getAssetDetail, createMoneyEvent } = setup();
    getAssetDetail.mockResolvedValue({
      id: 'asset-gold',
      type: 'bank_account',
      liquidity: 'long_term',
    });

    await expect(
      service.completeCashflowEvent('hh-1', 'cf-1', { assetId: 'asset-gold' }),
    ).rejects.toThrow(BadRequestException);
    expect(createMoneyEvent).not.toHaveBeenCalled();
  });

  // A stock/gold asset has no stored cash balance, so debit/credit no-op on it.
  it('refuses a usable_now asset that holds no spendable balance', async () => {
    const { service, getAssetDetail, createMoneyEvent } = setup();
    getAssetDetail.mockResolvedValue({
      id: 'asset-stock',
      type: 'stock',
      liquidity: 'usable_now',
    });

    await expect(
      service.completeCashflowEvent('hh-1', 'cf-1', { assetId: 'asset-stock' }),
    ).rejects.toThrow(BadRequestException);
    expect(createMoneyEvent).not.toHaveBeenCalled();
  });

  it('refuses to complete an already-completed event', async () => {
    const { service, createMoneyEvent } = setup({ status: 'completed' });

    await expect(
      service.completeCashflowEvent('hh-1', 'cf-1', { assetId: 'asset-vcb' }),
    ).rejects.toThrow(ConflictException);
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
      // `assetId` supplied so this fails on the AMOUNT, not the wallet guard.
      service.completeCashflowEvent('hh-1', 'cf-1', {
        amount: -1,
        assetId: 'asset-vcb',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  describe('debt-derived events are read-only', () => {
    it('refuses to edit an event that belongs to a debt', async () => {
      const { service, updateCashflowEvent } = setup({ debtId: 'debt-1' });

      await expect(
        service.updateCashflowEvent('hh-1', 'cf-1', { amount: 999 }),
      ).rejects.toThrow(ConflictException);
      expect(updateCashflowEvent).not.toHaveBeenCalled();
    });

    it('refuses to delete an event that belongs to a debt', async () => {
      const { service, repository } = setup({ debtId: 'debt-1' });

      await expect(
        service.deleteCashflowEvent('hh-1', 'cf-1'),
      ).rejects.toThrow(ConflictException);
      expect(
        (repository as { deleteCashflowEvent: jest.Mock }).deleteCashflowEvent,
      ).not.toHaveBeenCalled();
    });

    // Recording that a payment happened is not an edit of the plan — the whole
    // point of the reminder is that it can be completed.
    it('still allows completing a debt repayment', async () => {
      const { service } = setup({ debtId: 'debt-1', recurrence: 'once' });

      const result = await service.completeCashflowEvent('hh-1', 'cf-1', {
        assetId: 'asset-vcb',
      });

      expect(result.event.status).toBe('completed');
    });

    it('leaves a normal event editable', async () => {
      const { service, updateCashflowEvent } = setup({ debtId: null });

      await service.updateCashflowEvent('hh-1', 'cf-1', { amount: 999 });

      expect(updateCashflowEvent).toHaveBeenCalledTimes(1);
    });
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
    // `category` is an FK now: creating an event resolves the system `other`
    // category through MoneyEventsService before it can build the row.
    const moneyEvents = {
      systemCategoryId: jest.fn(async () => 'cat-other'),
      resolveCategoryIdOrThrow: jest.fn(async (_hh: string, id: string) => id),
    } as never;
    const service = new CashflowEventsService(
      repository,
      {} as never,
      moneyEvents,
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
      settlementAssetId: 'wallet-1',
    });

    expect(inserted[0].requirement).toBe('required');
  });

  /**
   * An outflow reduces the goal money backed by the wallet it leaves from, so
   * one that names no wallet would either drain no goal (understating what it
   * costs) or force a guess at which one. Asking is what makes the goal impact
   * shown at planning time truthful.
   */
  // A debt is not tied to one wallet — the household repays from whichever
  // cash/bank wallet suits them that month — so a repayment scheduled months
  // ahead cannot name its wallet yet. `completeCashflowEvent` asks instead,
  // at the moment the money actually moves.
  it('accepts an outgoing event that names no settlement wallet', async () => {
    const { service, inserted } = setup();

    await service.createCashflowEvent('hh-1', {
      ...valid,
      direction: 'outgoing',
    });

    expect(inserted[0].settlementAssetId ?? null).toBeNull();
  });

  it('still accepts an incoming event with no settlement wallet', async () => {
    const { service, inserted } = setup();

    await service.createCashflowEvent('hh-1', { ...valid });

    expect(inserted[0].settlementAssetId ?? null).toBeNull();
  });

  it('defaults responsibility to the member creating the record', async () => {
    const { service, inserted } = setup();

    await service.createCashflowEvent('hh-1', valid, 'member-creator');

    expect(inserted[0].ownerMemberId).toBe('member-creator');
  });

  it('keeps an explicitly selected responsible member', async () => {
    const { service, inserted } = setup();

    await service.createCashflowEvent(
      'hh-1',
      { ...valid, ownerMemberId: 'member-partner' },
      'member-creator',
    );

    expect(inserted[0].ownerMemberId).toBe('member-partner');
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

  /**
   * A repayment reminder is generated FROM its debt and regenerated whenever the
   * debt's schedule changes, so a hand edit would be silently reverted and a
   * hand delete would reappear. The debt is the only place to change them.
   */
});

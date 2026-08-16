import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AttentionService } from './attention.service';
import type { ForecastInput } from '../forecast/domain/forecast.types';
import type { StoredAttentionItem } from './entities/attention-item.entity';
import type { DismissalTombstone } from './repositories/attention.repository.interface';

const M = 1_000_000;

function forecastInput(over: Partial<ForecastInput> = {}): ForecastInput {
  return {
    householdId: 'hh-1',
    asOfDate: '2026-08-13',
    horizonDays: 30,
    assets: [
      {
        assetId: 'a1',
        name: 'VCB',
        value: 5 * M,
        liquidity: 'usable_now',
        financialNature: 'household',
        valueUpdatedAt: '2026-08-13',
      },
    ],
    cashflowEvents: [
      {
        id: 'e1',
        name: 'Rent',
        direction: 'outgoing',
        amount: 20 * M,
        expectedDate: '2026-08-20',
        recurrence: 'once',
        recurrenceEndDate: null,
        requirement: 'required',
        certainty: 'confirmed',
        status: 'expected',
      },
    ],
    ...over,
  };
}

function setup(
  options: {
    stored?: StoredAttentionItem[];
    dismissals?: DismissalTombstone[];
    input?: Partial<ForecastInput>;
    updateFrequency?: 'weekly' | 'monthly' | 'manual';
  } = {},
) {
  const insertItem = jest.fn(async () => undefined);
  const attentionRepository = {
    assertHousehold: jest.fn(async () => ({
      id: 'hh-1',
      updateFrequency: options.updateFrequency ?? 'weekly',
    })),
    createId: jest.fn(() => 'new-id'),
    findOpenStoredItems: jest.fn(async () => options.stored ?? []),
    findStoredItemById: jest.fn(async (_hh: string, id: string) =>
      (options.stored ?? []).find((item) => item.id === id),
    ),
    findDismissals: jest.fn(async () => options.dismissals ?? []),
    insertItem,
    markSeen: jest.fn(async () => undefined),
    markResolved: jest.fn(async () => undefined),
    markDismissed: jest.fn(async () => undefined),
    countOpenStoredItems: jest.fn(async () => (options.stored ?? []).length),
  } as never;

  const forecast = {
    loadInput: jest.fn(async () => forecastInput(options.input)),
  } as never;

  return {
    service: new AttentionService(attentionRepository, forecast),
    attentionRepository: attentionRepository as Record<string, jest.Mock>,
    insertItem,
  };
}

function storedItem(
  over: Partial<StoredAttentionItem> = {},
): StoredAttentionItem {
  return {
    id: 'stored-1',
    householdId: 'hh-1',
    title: 'Nói chuyện về khoản này',
    reason: null,
    ruleCode: 'user_flagged',
    level: 'normal',
    status: 'open',
    amount: null,
    relatedObjectType: null,
    relatedObjectId: null,
    privacyOwnerMemberId: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    ...over,
  };
}

describe('AttentionService.listAttentionItems', () => {
  it('merges stored and derived signals into one list', async () => {
    const { service } = setup({ stored: [storedItem()] });

    const result = await service.listAttentionItems('hh-1');

    expect(result.storedCount).toBe(1);
    expect(result.derivedCount).toBeGreaterThan(0);
    expect(result.total).toBe(result.items.length);
    expect(new Set(result.items.map((i) => i.source))).toEqual(
      new Set(['stored', 'derived']),
    );
  });

  /**
   * The core of §29's derived/stored split. A derived signal has no row to
   * update, so a dismissal is a TOMBSTONE — and if the merge failed to consult
   * it, the signal the user waved off would reappear on the very next read.
   */
  it('suppresses a derived signal the household has dismissed', async () => {
    const before = await setup().service.listAttentionItems('hh-1');
    expect(before.items.map((i) => i.ruleCode)).toContain(
      'low_projected_balance',
    );

    const after = await setup({
      dismissals: [
        { ruleCode: 'low_projected_balance', relatedObjectId: null },
      ],
    }).service.listAttentionItems('hh-1');

    expect(after.items.map((i) => i.ruleCode)).not.toContain(
      'low_projected_balance',
    );
  });

  /**
   * The tombstone matches on rule code AND related object. Dismissing "rent is
   * due soon" must not also silence "electricity is due soon" — they are
   * different facts that happen to share a rule.
   */
  it('scopes a dismissal to its related object', async () => {
    const twoEvents = {
      cashflowEvents: [
        {
          id: 'rent',
          name: 'Rent',
          direction: 'outgoing' as const,
          amount: 1 * M,
          expectedDate: '2026-08-15',
          recurrence: 'once' as const,
          recurrenceEndDate: null,
          requirement: 'required' as const,
          certainty: 'confirmed' as const,
          status: 'expected' as const,
        },
        {
          id: 'power',
          name: 'Electricity',
          direction: 'outgoing' as const,
          amount: 1 * M,
          expectedDate: '2026-08-16',
          recurrence: 'once' as const,
          recurrenceEndDate: null,
          requirement: 'required' as const,
          certainty: 'confirmed' as const,
          status: 'expected' as const,
        },
      ],
    };

    const { service } = setup({
      input: twoEvents,
      dismissals: [
        { ruleCode: 'cashflow_required_due_soon', relatedObjectId: 'rent' },
      ],
    });

    const result = await service.listAttentionItems('hh-1');
    const dueSoon = result.items.filter(
      (i) => i.ruleCode === 'cashflow_required_due_soon',
    );

    expect(dueSoon.map((i) => i.relatedObjectId)).toEqual(['power']);
  });

  /**
   * The client owns all copy (hard i18n mandate) and §29 governs the tone.
   * A backend-rendered sentence can be neither translated nor softened.
   */
  it('emits no prose on derived signals — only codes and params', async () => {
    const { service } = setup();
    const result = await service.listAttentionItems('hh-1');

    for (const item of result.items.filter((i) => i.source === 'derived')) {
      expect(item.title).toBeNull();
      expect(item.reason).toBeNull();
      expect(item.ruleCode).toEqual(expect.any(String));
    }
  });

  it('surfaces the most urgent signal first', async () => {
    const { service } = setup({ stored: [storedItem()] });
    const result = await service.listAttentionItems('hh-1');

    const rank = { urgent: 0, important: 1, normal: 2 };
    const ranks = result.items.map((i) => rank[i.level]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('never writes while reading', async () => {
    const { service, insertItem, attentionRepository } = setup();
    await service.listAttentionItems('hh-1');

    expect(insertItem).not.toHaveBeenCalled();
    expect(attentionRepository.markSeen).not.toHaveBeenCalled();
    expect(attentionRepository.markResolved).not.toHaveBeenCalled();
    expect(attentionRepository.markDismissed).not.toHaveBeenCalled();
  });

  /**
   * A household on `manual` said "we'll update when we want to". Grading them
   * against a cadence they never agreed to is the nagging §29 forbids.
   */
  it('raises no staleness signal for a household on manual cadence', async () => {
    const { service } = setup({
      updateFrequency: 'manual',
      input: {
        assets: [
          {
            assetId: 'a1',
            name: 'VCB',
            value: 5 * M,
            liquidity: 'usable_now',
            financialNature: 'household',
            valueUpdatedAt: '2020-01-01',
          },
        ],
      },
    });

    const result = await service.listAttentionItems('hh-1');
    expect(result.items.map((i) => i.ruleCode)).not.toContain('stale_data');
  });
});

describe('AttentionService.dismissDerived', () => {
  it('writes a tombstone carrying the rule code and target', async () => {
    const { service, insertItem } = setup();

    await service.dismissDerived(
      'hh-1',
      { ruleCode: 'cashflow_overdue', relatedObjectId: 'e1' },
      'user-1',
    );

    expect(insertItem).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleCode: 'cashflow_overdue',
        relatedObjectId: 'e1',
        relatedObjectType: 'cashflow_event',
        status: 'dismissed',
      }),
    );
  });

  /** A double-tap on a phone must not surface an error for a done thing. */
  it('is idempotent', async () => {
    const { service, insertItem } = setup({
      dismissals: [
        { ruleCode: 'low_projected_balance', relatedObjectId: null },
      ],
    });

    const result = await service.dismissDerived('hh-1', {
      ruleCode: 'low_projected_balance',
    });

    expect(result.alreadyDismissed).toBe(true);
    expect(insertItem).not.toHaveBeenCalled();
  });

  it('rejects a rule code that is not a derived signal', async () => {
    const { service } = setup();
    await expect(
      service.dismissDerived('hh-1', { ruleCode: 'user_flagged' }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('AttentionService lifecycle actions', () => {
  /**
   * Derived ids (`derived:…`) are synthetic keys, not rows. A PATCH against one
   * must 404 rather than silently doing nothing and reporting success.
   */
  it('404s when the target is a derived id, not a stored row', async () => {
    const { service } = setup();
    await expect(
      service.markResolved('hh-1', 'derived:cashflow_overdue:e1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('resolves a stored item', async () => {
    const { service, attentionRepository } = setup({
      stored: [storedItem({ id: 'stored-9' })],
    });

    const result = await service.markResolved('hh-1', 'stored-9', 'user-1');

    expect(result.status).toBe('resolved');
    expect(attentionRepository.markResolved).toHaveBeenCalledWith(
      'stored-9',
      'user-1',
    );
  });
});

describe('AttentionService.countOpenStoredItems', () => {
  /**
   * A snapshot freezes STORED items only. A derived count depends on a forecast
   * that will have moved by the time anyone reads the snapshot back, so
   * freezing it would put a number in the row that nothing can recompute.
   */
  it('counts stored items only', async () => {
    const { service, attentionRepository } = setup({
      stored: [storedItem({ id: 's1' }), storedItem({ id: 's2' })],
    });

    await expect(service.countOpenStoredItems('hh-1')).resolves.toBe(2);
    expect(attentionRepository.countOpenStoredItems).toHaveBeenCalledWith(
      'hh-1',
    );
  });
});

import { ActivityService } from './activity.service';
import type { PrismaService } from '../../database/prisma/prisma.service';

const HOUSEHOLD = 'hh-1';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'a-1',
    createdAt: new Date('2026-08-15T03:00:00.000Z'),
    action: 'asset.value_updated',
    entityType: 'asset',
    entityId: 'asset-1',
    metadata: {},
    actor: { id: 'user-an', fullName: 'An Nguyen', displayName: 'An' },
    ...over,
  };
}

function setup(rows: ReturnType<typeof row>[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = {
    client: () => ({ auditLog: { findMany } }),
  } as unknown as PrismaService;
  return { service: new ActivityService(prisma), findMany };
}

describe('ActivityService.listActivity', () => {
  it('emits action CODES and structured impact, never prose', async () => {
    const { service } = setup([
      row({ metadata: { objectName: 'VCB', amount: 2_400_000, impact: { metric: 'liquid', delta: 2_400_000 } } }),
    ]);

    const { items } = await service.listActivity(HOUSEHOLD);

    expect(items[0]).toEqual({
      id: 'a-1',
      occurredAt: '2026-08-15T03:00:00.000Z',
      actor: { id: 'user-an', name: 'An' },
      action: 'asset.value_updated',
      objectType: 'asset',
      objectId: 'asset-1',
      objectName: 'VCB',
      amount: 2_400_000,
      impact: { metric: 'liquid', delta: 2_400_000 },
    });
  });

  /**
   * The journal is the one place both partners are guaranteed to look, so it is
   * the worst possible place to leak the specifics of a record its owner chose
   * not to itemize. Folding has to hold here or it does not hold at all.
   */
  it('does not print the name or amount of a folded record', async () => {
    const { service } = setup([
      row({
        action: 'record.visibility_changed',
        metadata: { objectName: 'Sổ tiết kiệm', amount: 40_000_000, visibilityLevel: 'summary_only' },
      }),
    ]);

    const { items } = await service.listActivity(HOUSEHOLD);

    expect(items[0].objectName).toBeNull();
    expect(items[0].amount).toBeNull();
    // The action itself still shows: that a change happened is never hidden.
    expect(items[0].action).toBe('record.visibility_changed');
  });

  it('reports a null actor for system writes rather than inventing one', async () => {
    const { service } = setup([row({ actor: null })]);

    const { items } = await service.listActivity(HOUSEHOLD);

    expect(items[0].actor).toBeNull();
  });

  it('pages with a cursor and does not leak the lookahead row', async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      row({ id: `a-${i}`, createdAt: new Date(`2026-08-1${5 - i}T03:00:00.000Z`) }),
    );
    const { service, findMany } = setup(rows);

    const result = await service.listActivity(HOUSEHOLD, { limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('2026-08-14T03:00:00.000Z');
    // limit + 1, so "is there more" costs no extra query.
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
  });

  it('has no next cursor on the last page', async () => {
    const { service } = setup([row()]);

    const result = await service.listActivity(HOUSEHOLD, { limit: 20 });

    expect(result.nextCursor).toBeNull();
  });

  it('clamps a silly limit instead of trusting the query string', async () => {
    const { service, findMany } = setup([row()]);

    await service.listActivity(HOUSEHOLD, { limit: '9999' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101 }));
  });
});

import { BillingExpiryCron } from './billing-expiry.cron';

/**
 * The advisory lock is real Postgres, so the spec stands in for it with a
 * `pg_try_advisory_lock` that answers whatever the case needs — the lock's own
 * behaviour is covered by `advisory-lock.spec.ts`.
 */
function setup(
  options: {
    lockAcquired?: boolean;
    households?: string[];
    orders?: number;
    subscriptionSweepThrows?: boolean;
    orderSweepThrows?: boolean;
    invalidateThrows?: boolean;
  } = {},
) {
  const billingRepository = {
    expireLapsedSubscriptions: jest.fn(async () => {
      if (options.subscriptionSweepThrows) throw new Error('db down');
      return options.households ?? [];
    }),
    expireStalePaymentOrders: jest.fn(async () => {
      if (options.orderSweepThrows) throw new Error('db down');
      return options.orders ?? 0;
    }),
  } as never;

  const entitlements = {
    invalidate: jest.fn(async () => {
      if (options.invalidateThrows) throw new Error('redis down');
    }),
  } as never;

  const prisma = {
    client: () => ({
      $queryRawUnsafe: jest.fn(async (sql: string) =>
        sql.includes('pg_try_advisory_lock')
          ? [{ ok: options.lockAcquired ?? true }]
          : [],
      ),
    }),
  } as never;

  return {
    cron: new BillingExpiryCron(billingRepository, entitlements, prisma),
    billingRepository: billingRepository as Record<string, jest.Mock>,
    entitlements: entitlements as Record<string, jest.Mock>,
  };
}

describe('BillingExpiryCron', () => {
  afterEach(() => {
    delete process.env.BILLING_EXPIRY_CRON_ENABLED;
    delete process.env.BILLING_EXPIRY_BATCH_LIMIT;
  });

  it('flips lapsed subscriptions and closes stale orders in one sweep', async () => {
    const { cron, billingRepository } = setup({
      households: ['hh-1', 'hh-2'],
      orders: 3,
    });

    const result = await cron.run();

    expect(result).toEqual({ subscriptions: 2, orders: 3 });
    expect(billingRepository.expireLapsedSubscriptions).toHaveBeenCalledTimes(1);
    expect(billingRepository.expireStalePaymentOrders).toHaveBeenCalledTimes(1);
  });

  // The rows are already flipped; a cache still holding the old row would keep
  // serving Premium until its TTL.
  it('drops the entitlement cache for every household it expired', async () => {
    const { cron, entitlements } = setup({ households: ['hh-1', 'hh-2'] });

    await cron.run();

    expect(entitlements.invalidate).toHaveBeenCalledWith('hh-1');
    expect(entitlements.invalidate).toHaveBeenCalledWith('hh-2');
  });

  it('passes the same cutoff to both halves', async () => {
    const { cron, billingRepository } = setup();

    await cron.run();

    const subscriptionNow = billingRepository.expireLapsedSubscriptions.mock
      .calls[0][0] as Date;
    const orderNow = billingRepository.expireStalePaymentOrders.mock
      .calls[0][0] as Date;
    expect(subscriptionNow.getTime()).toBe(orderNow.getTime());
  });

  it('does nothing when another instance holds the lock', async () => {
    const { cron, billingRepository } = setup({ lockAcquired: false });

    const result = await cron.run();

    expect(result).toEqual({ subscriptions: 0, orders: 0 });
    expect(billingRepository.expireLapsedSubscriptions).not.toHaveBeenCalled();
  });

  it('honours the env kill switch', async () => {
    process.env.BILLING_EXPIRY_CRON_ENABLED = 'false';
    const { cron, billingRepository } = setup();

    await cron.sweepExpired();

    expect(billingRepository.expireLapsedSubscriptions).not.toHaveBeenCalled();
  });

  // The two halves are independent: an unpaid checkout must still be closed
  // when the subscription sweep cannot run.
  it('still sweeps orders when the subscription sweep fails', async () => {
    const { cron, billingRepository } = setup({
      subscriptionSweepThrows: true,
      orders: 2,
    });

    const result = await cron.run();

    expect(result).toEqual({ subscriptions: 0, orders: 2 });
    expect(billingRepository.expireStalePaymentOrders).toHaveBeenCalledTimes(1);
  });

  // The row is already flipped and `resolveEntitlement` re-checks the period on
  // every read, so a failed DEL costs a stale cache entry, never Premium.
  it('reports the sweep even when a cache drop fails', async () => {
    const { cron } = setup({ households: ['hh-1'], invalidateThrows: true });

    await expect(cron.run()).resolves.toEqual({ subscriptions: 1, orders: 0 });
  });

  it('reads its batch limit from the environment', async () => {
    process.env.BILLING_EXPIRY_BATCH_LIMIT = '50';
    const { cron, billingRepository } = setup();

    await cron.run();

    expect(billingRepository.expireLapsedSubscriptions.mock.calls[0][1]).toBe(50);
  });

  it('falls back to the default limit when the env var is nonsense', async () => {
    process.env.BILLING_EXPIRY_BATCH_LIMIT = 'not-a-number';
    const { cron, billingRepository } = setup();

    await cron.run();

    expect(billingRepository.expireLapsedSubscriptions.mock.calls[0][1]).toBe(
      500,
    );
  });

  // Running twice concurrently must do the work once — the in-process flag
  // covers this instance, the advisory lock covers the others.
  it('skips a tick that starts while the previous one is still running', async () => {
    const { cron, billingRepository } = setup();
    let release!: () => void;
    billingRepository.expireLapsedSubscriptions.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => {
        release = () => resolve([]);
      }),
    );

    const first = cron.run();
    const second = await cron.run();
    release();
    await first;

    expect(second).toEqual({ subscriptions: 0, orders: 0 });
    expect(billingRepository.expireLapsedSubscriptions).toHaveBeenCalledTimes(1);
  });
});

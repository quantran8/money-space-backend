import { PaymentsService } from './payments.service';
import { signPayload } from './domain/payos-signature';

const CHECKSUM_KEY = 'test-checksum-key';

/**
 * The webhook, which is where the money actually lands.
 *
 * The property under test throughout is that a household can never be granted
 * two periods for one payment, and can never be granted none for a payment
 * that succeeded.
 */
function makeService(
  options: {
    order?: {
      orderCode: bigint;
      householdId: string;
      status: string;
      planCode: string;
      amount: number;
      durationDays: number | null;
    } | null;
    /** Whether the conditional UPDATE claims the row. */
    claims?: boolean;
  } = {},
) {
  const order =
    options.order === undefined
      ? {
          orderCode: 175735680042n,
          householdId: 'hh-1',
          status: 'pending',
          planCode: 'premium_monthly',
          amount: 39_000,
          durationDays: 30,
        }
      : options.order;

  const markPaymentOrderPaid = jest.fn(async () => options.claims ?? true);
  const recordPaymentPayload = jest.fn(async () => undefined);
  const grantOrExtend = jest.fn(async () => ({
    periodEnd: new Date('2026-10-07'),
    periodEndBefore: null,
    addedDays: 30,
    stacked: false,
    noop: false,
  }));

  const service = new PaymentsService(
    {
      findPaymentOrderByCode: jest.fn(async () => order),
      markPaymentOrderPaid,
      recordPaymentPayload,
    } as never,
    {} as never,
    { grantOrExtend } as never,
    {
      // Runs the work inline, like the real one does inside a transaction.
      runInTransactionAndInvalidate: jest.fn(
        async (_id: string, work: () => Promise<unknown>) => work(),
      ),
    } as never,
    { record: jest.fn() } as never,
  );

  return { service, markPaymentOrderPaid, recordPaymentPayload, grantOrExtend };
}

/** A signed webhook body, the way PayOS sends one. */
function webhook(over: Record<string, unknown> = {}) {
  const data = {
    orderCode: 175735680042,
    amount: 39_000,
    description: 'OURSIGHT',
    reference: 'FT25001234567',
    transactionDateTime: '2026-09-07 14:32:11',
    currency: 'VND',
    code: '00',
    desc: 'success',
    ...over,
  };
  return { code: '00', desc: 'success', data, signature: signPayload(data, CHECKSUM_KEY) };
}

describe('PayOS webhook', () => {
  const original = process.env.PAYOS_CHECKSUM_KEY;
  beforeAll(() => {
    process.env.PAYOS_CHECKSUM_KEY = CHECKSUM_KEY;
  });
  afterAll(() => {
    process.env.PAYOS_CHECKSUM_KEY = original;
  });

  it('grants the period for a genuine payment', async () => {
    const { service, grantOrExtend } = makeService();

    await expect(service.handleWebhook(webhook())).resolves.toBe('granted');
    expect(grantOrExtend).toHaveBeenCalledWith(
      'hh-1',
      { type: 'duration_days', days: 30 },
      'payment',
    );
  });

  it('grants a LIFETIME plan as lifetime, not as zero days', async () => {
    const { service, grantOrExtend } = makeService({
      order: {
        orderCode: 175735680042n,
        householdId: 'hh-1',
        status: 'pending',
        planCode: 'premium_lifetime',
        amount: 699_000,
        durationDays: null,
      },
    });

    await service.handleWebhook(webhook({ amount: 699_000 }));
    expect(grantOrExtend).toHaveBeenCalledWith(
      'hh-1',
      { type: 'lifetime' },
      'payment',
    );
  });

  describe('idempotency', () => {
    it('does not grant twice for an order already marked paid', async () => {
      const { service, grantOrExtend } = makeService({
        order: {
          orderCode: 175735680042n,
          householdId: 'hh-1',
          status: 'paid',
          planCode: 'premium_monthly',
          amount: 39_000,
          durationDays: 30,
        },
      });

      await expect(service.handleWebhook(webhook())).resolves.toBe(
        'already_handled',
      );
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    it('does not grant when the conditional UPDATE claims no row', async () => {
      // Two deliveries raced: the other transaction committed first, so
      // `WHERE status = 'pending'` matched nothing here.
      const { service, grantOrExtend } = makeService({ claims: false });

      await service.handleWebhook(webhook());
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    it('treats a unique-constraint violation as already handled, not an error', async () => {
      // The `provider_txn_id` unique index fired — the primary barrier. It
      // must NOT surface as a 500, or PayOS would retry a settled payment.
      const { service } = makeService();
      const failing = new PaymentsService(
        {
          findPaymentOrderByCode: jest.fn(async () => ({
            orderCode: 175735680042n,
            householdId: 'hh-1',
            status: 'pending',
            planCode: 'premium_monthly',
            amount: 39_000,
            durationDays: 30,
          })),
          markPaymentOrderPaid: jest.fn(async () => {
            throw Object.assign(new Error('duplicate'), { code: 'P2002' });
          }),
        } as never,
        {} as never,
        { grantOrExtend: jest.fn() } as never,
        {
          runInTransactionAndInvalidate: jest.fn(
            async (_id: string, work: () => Promise<unknown>) => work(),
          ),
        } as never,
        { record: jest.fn() } as never,
      );

      await expect(failing.handleWebhook(webhook())).resolves.toBe(
        'already_handled',
      );
      expect(service).toBeDefined();
    });

    it('rethrows a transient failure so PayOS retries it', async () => {
      // The database being down IS worth retrying — this is the one case that
      // must not be swallowed into a 200.
      const failing = new PaymentsService(
        {
          findPaymentOrderByCode: jest.fn(async () => ({
            orderCode: 175735680042n,
            householdId: 'hh-1',
            status: 'pending',
            planCode: 'premium_monthly',
            amount: 39_000,
            durationDays: 30,
          })),
          markPaymentOrderPaid: jest.fn(async () => {
            throw new Error('connection refused');
          }),
        } as never,
        {} as never,
        { grantOrExtend: jest.fn() } as never,
        {
          runInTransactionAndInvalidate: jest.fn(
            async (_id: string, work: () => Promise<unknown>) => work(),
          ),
        } as never,
        { record: jest.fn() } as never,
      );

      await expect(failing.handleWebhook(webhook())).rejects.toThrow(
        'connection refused',
      );
    });
  });

  describe('what must never grant', () => {
    it('rejects a forged signature without granting', async () => {
      const { service, grantOrExtend } = makeService();
      const body = webhook();

      await expect(
        service.handleWebhook({ ...body, signature: 'f'.repeat(64) }),
      ).resolves.toBe('bad_signature');
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    it('rejects a body whose amount was altered after signing', async () => {
      const { service, grantOrExtend } = makeService();
      const body = webhook();
      // Signature still the original; the data no longer matches it.
      const tampered = { ...body, data: { ...body.data, amount: 1 } };

      await expect(service.handleWebhook(tampered)).resolves.toBe(
        'bad_signature',
      );
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    it('answers an unknown order calmly rather than retrying forever', async () => {
      const { service, grantOrExtend } = makeService({ order: null });

      await expect(service.handleWebhook(webhook())).resolves.toBe(
        'unknown_order',
      );
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    it('leaves an UNDERPAID order pending and records what arrived', async () => {
      // Somebody sent real money, just not enough. It is not cancelled — a
      // person decides, and rawPayload is what they need to see.
      const { service, grantOrExtend, recordPaymentPayload } = makeService();

      await expect(
        service.handleWebhook(webhook({ amount: 20_000 })),
      ).resolves.toBe('underpaid');
      expect(grantOrExtend).not.toHaveBeenCalled();
      expect(recordPaymentPayload).toHaveBeenCalled();
    });

    it('accepts PayOS\'s registration ping without treating it as a failure', async () => {
      // PayOS calls the endpoint once to verify the URL. Answering it with an
      // error would fail the registration.
      const { service, grantOrExtend } = makeService();

      await expect(service.handleWebhook({})).resolves.toBe('test_ping');
      await expect(service.handleWebhook({ data: {} })).resolves.toBe(
        'test_ping',
      );
      expect(grantOrExtend).not.toHaveBeenCalled();
    });
  });
});

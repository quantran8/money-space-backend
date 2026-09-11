import { RevenuecatService } from './revenuecat.service';
import { noopAnalytics } from '../../common/analytics/test-support/analytics.fixture';
import type { RevenuecatWebhookBody } from './domain/revenuecat-event';

/**
 * The webhook, which is where in-app money actually lands.
 *
 * The property under test throughout is the same one the PayOS spec protects:
 * a household can never be granted two periods for one purchase, and can never
 * be granted none for a purchase that succeeded. Plus one specific to IAP —
 * nothing here may ever SHORTEN a period.
 */
function makeService(
  options: {
    subscriber?: { providerUserId: string; profileId: string | null; householdId: string } | null;
    /** Throw a unique violation from the insert, as a replay would. */
    duplicate?: boolean;
  } = {},
) {
  const subscriber =
    options.subscriber === undefined
      ? { providerUserId: 'user-1', profileId: 'user-1', householdId: 'hh-1' }
      : options.subscriber;

  const insertStorePurchase = jest.fn(async () => {
    if (options.duplicate) {
      throw Object.assign(new Error('unique violation'), { code: 'P2002' });
    }
  });
  const linkRevenuecatSubscriber = jest.fn(async () => undefined);
  const grantOrExtend = jest.fn(async () => ({
    periodEnd: new Date('2027-09-07'),
    periodEndBefore: null,
    addedDays: 365,
    stacked: false,
    noop: false,
  }));
  const record = jest.fn();

  const service = new RevenuecatService(
    {
      findRevenuecatSubscriber: jest.fn(async () => subscriber),
      insertStorePurchase,
      linkRevenuecatSubscriber,
    } as never,
    { grantOrExtend } as never,
    {
      runInTransactionAndInvalidate: jest.fn(
        async (_id: string, work: () => Promise<unknown>) => work(),
      ),
    } as never,
    { record } as never,
    noopAnalytics(),
  );

  return { service, insertStorePurchase, linkRevenuecatSubscriber, grantOrExtend, record };
}

function webhook(over: Record<string, unknown> = {}): RevenuecatWebhookBody {
  return {
    api_version: '1.0',
    event: {
      type: 'INITIAL_PURCHASE',
      app_user_id: 'user-1',
      product_id: 'oursight_premium_yearly',
      entitlement_ids: ['premium'],
      store: 'APP_STORE',
      environment: 'PRODUCTION',
      transaction_id: 'txn-1',
      purchased_at_ms: Date.parse('2026-09-07T10:00:00Z'),
      expiration_at_ms: Date.parse('2027-09-07T10:00:00Z'),
      price_in_purchased_currency: 299_000,
      ...over,
    },
  };
}

describe('RevenueCat webhook', () => {
  const originalSandbox = process.env.REVENUECAT_ALLOW_SANDBOX;
  afterEach(() => {
    process.env.REVENUECAT_ALLOW_SANDBOX = originalSandbox;
  });

  describe('a purchase', () => {
    it('grants the plan the product maps to', async () => {
      const { service, grantOrExtend } = makeService();

      await expect(service.handleWebhook(webhook())).resolves.toBe('granted');

      expect(grantOrExtend).toHaveBeenCalledWith(
        'hh-1',
        { type: 'duration_days', days: 365 },
        'payment',
      );
    });

    it('grants lifetime with no expiry, not a very long period', async () => {
      const { service, grantOrExtend } = makeService();

      await service.handleWebhook(
        webhook({ product_id: 'oursight_premium_lifetime', expiration_at_ms: null }),
      );

      expect(grantOrExtend).toHaveBeenCalledWith(
        'hh-1',
        { type: 'lifetime' },
        'payment',
      );
    });

    /** A renewal is a fresh charge, and must extend rather than be a no-op. */
    it('grants again on a renewal', async () => {
      const { service, grantOrExtend } = makeService();

      await expect(
        service.handleWebhook(webhook({ type: 'RENEWAL', transaction_id: 'txn-2' })),
      ).resolves.toBe('granted');
      expect(grantOrExtend).toHaveBeenCalled();
    });

    /** The store's price in đồng, not our list price. */
    it('records what the store actually charged', async () => {
      const { service, insertStorePurchase } = makeService();

      await service.handleWebhook(webhook({ price_in_purchased_currency: 279_000 }));

      expect(insertStorePurchase).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 279_000, productId: 'oursight_premium_yearly' }),
      );
    });

    /** Apple charging a card a year later is not a person acting. */
    it('attributes a renewal to nobody', async () => {
      const { service, insertStorePurchase } = makeService();

      await service.handleWebhook(webhook({ type: 'RENEWAL' }));

      expect(insertStorePurchase).toHaveBeenCalledWith(
        expect.objectContaining({ createdById: null }),
      );
    });
  });

  describe('idempotency', () => {
    /** The unique provider_txn_id is the barrier; a replay must grant nothing. */
    it('treats a replayed delivery as already handled', async () => {
      const { service, grantOrExtend } = makeService({ duplicate: true });

      await expect(service.handleWebhook(webhook())).resolves.toBe('already_handled');
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    /** A database outage IS worth retrying, so it must not be swallowed. */
    it('rethrows a transient failure so RevenueCat retries', async () => {
      const { service } = makeService();
      (service as never as { billingRepository: { insertStorePurchase: jest.Mock } })
        .billingRepository.insertStorePurchase.mockRejectedValueOnce(
          new Error('connection terminated'),
        );

      await expect(service.handleWebhook(webhook())).rejects.toThrow(
        'connection terminated',
      );
    });
  });

  describe('what it refuses to act on', () => {
    /**
     * The invariant: an IAP only ever ADDS time. Cancelling turns auto-renew
     * off — the household keeps the days it bought.
     */
    it('does nothing on a cancellation', async () => {
      const { service, grantOrExtend } = makeService();

      await expect(
        service.handleWebhook(webhook({ type: 'CANCELLATION' })),
      ).resolves.toBe('ignored');
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    it('does nothing on an expiration — the cron owns that', async () => {
      const { service, grantOrExtend } = makeService();

      await expect(
        service.handleWebhook(webhook({ type: 'EXPIRATION' })),
      ).resolves.toBe('ignored');
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    it('records a refund without revoking anything', async () => {
      const { service, grantOrExtend } = makeService();

      await expect(
        service.handleWebhook(webhook({ type: 'REFUND' })),
      ).resolves.toBe('revocation_logged');
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    it('refuses a product it does not sell', async () => {
      const { service, grantOrExtend } = makeService();

      await expect(
        service.handleWebhook(webhook({ product_id: 'some_other_product' })),
      ).resolves.toBe('unknown_product');
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    /** Money we cannot attribute must not be guessed at. */
    it('refuses a subscriber it cannot map to a household', async () => {
      const { service, grantOrExtend } = makeService({ subscriber: null });

      await expect(service.handleWebhook(webhook())).resolves.toBe(
        'unknown_subscriber',
      );
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    it('refuses a product attached to the wrong entitlement', async () => {
      const { service, grantOrExtend } = makeService();

      await expect(
        service.handleWebhook(webhook({ entitlement_ids: ['something_else'] })),
      ).resolves.toBe('wrong_entitlement');
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    /** A sandbox receipt is free money in production. */
    it('refuses a sandbox purchase unless explicitly allowed', async () => {
      process.env.REVENUECAT_ALLOW_SANDBOX = 'false';
      const { service, grantOrExtend } = makeService();

      await expect(
        service.handleWebhook(webhook({ environment: 'SANDBOX' })),
      ).resolves.toBe('sandbox_ignored');
      expect(grantOrExtend).not.toHaveBeenCalled();
    });

    it('allows a sandbox purchase where testing needs it', async () => {
      process.env.REVENUECAT_ALLOW_SANDBOX = 'true';
      const { service } = makeService();

      await expect(
        service.handleWebhook(webhook({ environment: 'SANDBOX' })),
      ).resolves.toBe('granted');
    });

    it('shrugs at the test ping sent when the URL is saved', async () => {
      const { service } = makeService();
      await expect(service.handleWebhook({})).resolves.toBe('ignored');
    });
  });
});

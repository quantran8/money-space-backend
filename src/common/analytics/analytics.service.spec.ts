import { AnalyticsService } from './analytics.service';

/**
 * The contract worth pinning is FAIL-OPEN, the same one the Redis counter and
 * `CacheService` hold: analytics being unreachable — or simply switched off —
 * must never be the reason a household's request is slower or fails.
 *
 * No key is the normal state on a dev machine and in CI, so it is the first
 * case tested rather than an afterthought.
 */
describe('AnalyticsService', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  /** `analyticsConfig.enabled` is false under NODE_ENV=test whatever the key. */
  function makeService(): AnalyticsService {
    return new AnalyticsService();
  }

  /**
   * Swap in a failing client. `client` is readonly in production on purpose —
   * nothing outside the constructor may replace it — so the cast is confined to
   * this helper rather than loosening the field itself.
   */
  function withClient(service: AnalyticsService, double: unknown): void {
    (service as unknown as { client: unknown }).client = double;
  }

  it('builds no client when there is no key', () => {
    delete process.env.POSTHOG_API_KEY;
    const service = makeService();

    expect(service['client']).toBeNull();
  });

  it('builds no client under test even when a key is present', () => {
    // A spec that reached the network would be flaky and would leak fixture
    // data into a real project.
    process.env.POSTHOG_API_KEY = 'phc_test_key';
    process.env.NODE_ENV = 'test';

    expect(makeService()['client']).toBeNull();
  });

  it('captures without throwing when disabled', () => {
    const service = makeService();

    expect(() =>
      service.capture('hh-1', 'trial_started', { days: 14 }),
    ).not.toThrow();
  });

  it('returns undefined rather than a promise, so it cannot be awaited by accident', () => {
    const service = makeService();

    // A promise here would let a caller block a request on analytics, and a
    // rejected one would reach main.ts's unhandledRejection guard.
    expect(service.capture('hh-1', 'trial_started', { days: 14 })).toBeUndefined();
  });

  it('swallows a throwing client and logs once', () => {
    const service = makeService();
    const boom = () => {
      throw new Error('posthog is down');
    };
    withClient(service, { capture: boom });
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();

    expect(() =>
      service.capture('hh-1', 'trial_started', { days: 14 }),
    ).not.toThrow();
    expect(() =>
      service.capture('hh-2', 'trial_started', { days: 14 }),
    ).not.toThrow();

    // Once, not per request: a dead endpoint must not triple the log volume.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never puts the failing payload in the log line', () => {
    const service = makeService();
    withClient(service, {
      capture: () => {
        throw new Error('posthog is down');
      },
    });
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();

    service.capture('hh-1', 'checkout_created', {
      plan_code: 'premium_yearly',
      price_vnd: 299_000,
      discount_percent: 0,
      from_reason: null,
    });

    expect(warn.mock.calls[0][0]).not.toContain('299000');
    expect(warn.mock.calls[0][0]).not.toContain('premium_yearly');
  });

  it('shuts down cleanly when there is no client', async () => {
    await expect(makeService().onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('attributes a product-wide figure to the system, not to a household', () => {
    const service = makeService();
    const capture = jest.fn();
    withClient(service, { capture });

    service.captureSystem('metrics_weekly', { households: 12 });

    const sent = capture.mock.calls[0][0];
    // A fake household id here would show up in every insight that groups by
    // one. The sentinel keeps the weekly series a single timeline instead.
    expect(sent.distinctId).toBe('oursight-system');
    expect(sent.properties.household_id).toBeUndefined();
    expect(sent.properties.is_system).toBe(true);
  });

  it('does not throw when a product-wide capture fails', () => {
    const service = makeService();
    withClient(service, {
      capture: () => {
        throw new Error('posthog is down');
      },
    });
    jest.spyOn(service['logger'], 'warn').mockImplementation();

    expect(() => service.captureSystem('metrics_weekly', {})).not.toThrow();
  });

  it('flushes without throwing when there is no client', async () => {
    await expect(makeService().flush()).resolves.toBeUndefined();
  });

  it('does not let a hung flush fail the shutdown', async () => {
    const service = makeService();
    withClient(service, {
      _shutdown: () => Promise.reject(new Error('timed out')),
    });
    jest.spyOn(service['logger'], 'warn').mockImplementation();

    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
  });
});

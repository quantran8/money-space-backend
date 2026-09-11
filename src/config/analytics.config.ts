/**
 * Analytics configuration.
 *
 * Every field is a GETTER, not a value — the same rule, and the same reason, as
 * `billing.config.ts`: `ConfigModule.forRoot()` populates `process.env` from
 * `.env` while `AppModule`'s imports array is evaluated, which is AFTER this
 * module has been imported. A plain field would capture whatever the shell
 * exported and ignore `.env` entirely. (`app.config.ts` and `cache.config.ts`
 * still have the latent form of that bug — do not copy them.)
 *
 * No key means no client is constructed and every capture is a no-op, so local
 * development, CI and tests need no PostHog account. Same contract as
 * `REDIS_URL` being unset.
 */
export const analyticsConfig = {
  /** PostHog project key. Empty ⇒ analytics is off entirely. */
  get apiKey(): string {
    return process.env.POSTHOG_API_KEY ?? '';
  },

  /**
   * Region host. EU by default: the households are Vietnamese and the data is
   * financial-adjacent, so a US default would be a decision made by
   * inattention. It cannot be changed after a project is created.
   */
  get host(): string {
    return process.env.POSTHOG_HOST ?? 'https://eu.i.posthog.com';
  },

  /**
   * Whether anything is sent at all.
   *
   * Tests never send, regardless of key — a spec that reached the network would
   * be slow and flaky, and would leak fixture data into a real project.
   */
  get enabled(): boolean {
    if (process.env.NODE_ENV === 'test') return false;
    if (process.env.ANALYTICS_ENABLED === 'false') return false;
    return this.apiKey !== '';
  },

  /**
   * 5xx tracking, switchable independently of product analytics so a noisy
   * incident can be silenced without going blind on the funnel.
   */
  get errorTrackingEnabled(): boolean {
    return this.enabled && process.env.ERROR_TRACKING_ENABLED !== 'false';
  },

  /** Batched in the background; a request never waits for a flush. */
  get flushAt(): number {
    return Number(process.env.POSTHOG_FLUSH_AT ?? 20);
  },
  get flushIntervalMs(): number {
    return Number(process.env.POSTHOG_FLUSH_INTERVAL_MS ?? 10_000);
  },

  /**
   * How long shutdown may wait for the final flush. A hung endpoint must not
   * hold the container open past the orchestrator's grace period.
   */
  get shutdownTimeoutMs(): number {
    return Number(process.env.POSTHOG_SHUTDOWN_TIMEOUT_MS ?? 3_000);
  },

  /** Our own accounts and beta testers, filtered out of every insight. */
  get internalUserIds(): string[] {
    return (process.env.ANALYTICS_INTERNAL_USER_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  },
};

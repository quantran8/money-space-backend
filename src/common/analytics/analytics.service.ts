import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { PostHog } from 'posthog-node';
import { analyticsConfig } from '../../config/analytics.config';
import type {
  AnalyticsEventMap,
  AnalyticsEventName,
} from './event-catalog';

/**
 * Product analytics and 5xx tracking, in one place.
 *
 * Shaped after `AuditService` — one method, household first — with one
 * deliberate difference: **`capture` returns `void`, not a promise.** The
 * journal is awaited because an entry must roll back with the write it
 * describes; analytics is the opposite. A `void` return makes "forgot to
 * await" impossible rather than merely discouraged, keeps `assertQuota`
 * synchronous, and means a broken PostHog can never extend a request or turn a
 * 402 into a 500.
 *
 * Fail-open throughout, like the Redis counter: no key ⇒ no client ⇒ every call
 * is a no-op, so local dev, CI and tests need no PostHog account.
 *
 * `distinctId` is the HOUSEHOLD, not the person: the product is priced and
 * gated per household, and every question worth asking is "% of households".
 * The actor rides along as a property where a per-person question is actually
 * being asked. See [[analytics]].
 */
/**
 * The subject a product-wide figure is attributed to. One fixed id, so the
 * weekly series is a single timeline in PostHog rather than a new anonymous
 * person every run.
 */
const SYSTEM_DISTINCT_ID = 'oursight-system';

@Injectable()
export class AnalyticsService implements OnApplicationShutdown {
  private readonly logger = new Logger('Analytics');
  private readonly client: PostHog | null;
  private readonly internalUserIds: Set<string>;

  /** Logged once, not per request — a dead endpoint must not flood the log. */
  private degraded = false;

  constructor() {
    this.internalUserIds = new Set(analyticsConfig.internalUserIds);
    this.client = analyticsConfig.enabled
      ? new PostHog(analyticsConfig.apiKey, {
          host: analyticsConfig.host,
          flushAt: analyticsConfig.flushAt,
          flushInterval: analyticsConfig.flushIntervalMs,
          // The server's own IP is not a household's location, and resolving it
          // on every event would attach a datacentre to all of them.
          disableGeoip: true,
        })
      : null;

    if (!this.client) {
      this.logger.log('Analytics disabled (no POSTHOG_API_KEY)');
    }
  }

  /**
   * Record one product event. Never throws, never blocks.
   *
   * Must be called AFTER the transaction it describes has committed — an event
   * for a write that rolled back is a figure nobody can reconcile.
   */
  capture<E extends AnalyticsEventName>(
    householdId: string,
    event: E,
    props: AnalyticsEventMap[E],
    actorId?: string | null,
  ): void {
    if (!this.client) return;

    try {
      this.client.capture({
        distinctId: householdId,
        event,
        properties: {
          ...props,
          household_id: householdId,
          platform: 'server',
          // Marks our own accounts so every insight can filter them out.
          ...(actorId && this.internalUserIds.has(actorId)
            ? { is_internal: true }
            : {}),
        },
        disableGeoip: true,
      });
    } catch (error) {
      this.markDegraded('capture', error);
    }
  }

  /**
   * A figure about the WHOLE product, not about one household.
   *
   * Separate from `capture()` because that one is household-shaped: it sets
   * `distinctId` to the household and stamps `household_id` on the payload.
   * A weekly total belongs to no household, and inventing an id for it would
   * put a fake household in every insight that groups by one.
   *
   * `distinctId` is a fixed sentinel so PostHog treats the whole series as one
   * subject — that is what makes it chart over time instead of scattering
   * across anonymous ids.
   */
  captureSystem(event: string, props: Record<string, unknown>): void {
    if (!this.client) return;

    try {
      this.client.capture({
        distinctId: SYSTEM_DISTINCT_ID,
        event,
        properties: { ...props, platform: 'server', is_system: true },
        disableGeoip: true,
      });
    } catch (error) {
      this.markDegraded('captureSystem', error);
    }
  }

  /** Flush now. A CLI exits immediately and would otherwise drop the batch. */
  async flush(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.flush();
    } catch (error) {
      this.markDegraded('flush', error);
    }
  }

  /**
   * Record an unexpected failure. Called from `HttpExceptionFilter` for 5xx
   * only — a 402 is the product working, not a fault.
   *
   * The caller is responsible for passing a route PATTERN and nothing from the
   * request body: both can carry a household's figures.
   */
  captureException(
    error: unknown,
    context: { householdId?: string; route?: string; statusCode?: number } = {},
  ): void {
    if (!this.client || !analyticsConfig.errorTrackingEnabled) return;

    try {
      this.client.captureException(error, context.householdId, {
        route: context.route,
        status_code: context.statusCode,
        platform: 'server',
      });
    } catch (captureError) {
      this.markDegraded('captureException', captureError);
    }
  }

  /**
   * Flush what is queued, then stop. Races a timeout so a hung endpoint cannot
   * hold the container open past its termination grace period.
   *
   * Reached only because `main.ts` calls `app.enableShutdownHooks()`.
   */
  async onApplicationShutdown(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client._shutdown(analyticsConfig.shutdownTimeoutMs);
    } catch (error) {
      this.markDegraded('shutdown', error);
    }
  }

  private markDegraded(stage: string, error: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    // The message only — an analytics payload must never reach the log either.
    this.logger.warn(
      `Analytics ${stage} failed; continuing without it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

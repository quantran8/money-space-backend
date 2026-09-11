import type { AnalyticsService } from '../analytics.service';

/**
 * An `AnalyticsService` that records instead of sending.
 *
 * Every service that emits takes one in its constructor, so without this each
 * spec would hand-roll its own mock and they would drift — the same argument
 * `billing/test-support/entitlement.fixture.ts` already makes.
 *
 * `captured` is the point: a spec asserts WHAT was emitted, and just as often
 * that a household's figures were not.
 */
export type CapturedEvent = {
  householdId: string;
  event: string;
  props: Record<string, unknown>;
  actorId?: string | null;
};

export interface FakeAnalytics extends AnalyticsService {
  captured: CapturedEvent[];
  capturedExceptions: unknown[];
  /** The last event of a given name, or undefined — the usual assertion. */
  lastOf(event: string): CapturedEvent | undefined;
}

export function noopAnalytics(): FakeAnalytics {
  const captured: CapturedEvent[] = [];
  const capturedExceptions: unknown[] = [];

  return {
    captured,
    capturedExceptions,
    capture(
      householdId: string,
      event: string,
      props: Record<string, unknown>,
      actorId?: string | null,
    ) {
      captured.push({ householdId, event, props, actorId });
    },
    captureException(error: unknown) {
      capturedExceptions.push(error);
    },
    lastOf(event: string) {
      return [...captured].reverse().find((entry) => entry.event === event);
    },
    onApplicationShutdown: () => Promise.resolve(),
  } as unknown as FakeAnalytics;
}

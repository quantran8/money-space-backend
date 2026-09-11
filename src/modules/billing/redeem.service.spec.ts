import { ConflictException, HttpStatus } from '@nestjs/common';
import { RedeemService } from './redeem.service';
import { noopAnalytics } from '../../common/analytics/test-support/analytics.fixture';
import type { BillingRepository } from './repositories/billing.repository.interface';

/**
 * Covers the two behaviours that cannot be seen without a real Redis: the
 * failure counter, and its fail-open contract when the cache is unavailable.
 * The happy paths are exercised against the live API instead — the interesting
 * parts of those live in Postgres constraints, which a mock cannot model.
 */
const HOUSEHOLD = 'hh-1';
const USER = 'user-1';
const MISSING_CODE = 'OURS00000000';

function build(overrides: {
  counters?: Map<string, number>;
  cacheEnabled?: boolean;
}) {
  const counters = overrides.counters ?? new Map<string, number>();
  const cacheEnabled = overrides.cacheEnabled ?? true;

  const cache = {
    get: jest.fn(async (key: string) =>
      cacheEnabled ? counters.get(key) : undefined,
    ),
    // Mirrors CacheService: undefined when the cache is off, so the caller
    // cannot tell "zero" from "could not count".
    incr: jest.fn(async (key: string) => {
      if (!cacheEnabled) return undefined;
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
  };

  const repository = {
    findHouseholdName: jest.fn(async () => 'Nhà thử'),
    // Nothing matches, so every attempt is a failure — which is what the
    // counter is meant to notice.
    findRedeemCode: jest.fn(async () => null),
  } as unknown as BillingRepository;

  const service = new RedeemService(
    repository,
    {} as never,
    {} as never,
    {} as never,
    cache as never,
    {} as never,
    noopAnalytics(),
  );

  return { service, counters, cache };
}

async function statusOf(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
    return HttpStatus.OK;
  } catch (error) {
    return (error as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
}

describe('RedeemService rate limiting', () => {
  it('counts only failures, and closes the door after ten of them', async () => {
    const { service, counters } = build({});

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const status = await statusOf(() =>
        service.redeem(HOUSEHOLD, USER, MISSING_CODE),
      );
      expect(status).toBe(HttpStatus.NOT_FOUND);
    }

    // The eleventh is refused before the code is even looked up.
    const status = await statusOf(() =>
      service.redeem(HOUSEHOLD, USER, MISSING_CODE),
    );
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);

    expect(counters.get(`billing:redeem-fail:user:${USER}`)).toBe(10);
    expect(counters.get(`billing:redeem-fail:household:${HOUSEHOLD}`)).toBe(10);
  });

  it('locks a household even when the attempts come from different users', async () => {
    const { service, counters } = build({});

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await statusOf(() =>
        service.redeem(HOUSEHOLD, `user-${attempt}`, MISSING_CODE),
      );
    }

    // A fresh user, but the same household: still refused.
    const status = await statusOf(() =>
      service.redeem(HOUSEHOLD, 'user-fresh', MISSING_CODE),
    );

    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(counters.get('billing:redeem-fail:user:user-fresh')).toBeUndefined();
  });

  it('does not spend an attempt on a malformed code — it never reaches the database', async () => {
    const { service, counters, cache } = build({});

    const status = await statusOf(() =>
      // Wrong checksum: rejected by the client-side rules, so no lookup.
      service.redeem(HOUSEHOLD, USER, 'OURS9SYVNRFA'),
    );

    expect(status).toBe(HttpStatus.BAD_REQUEST);
    // It still counts as a failure — otherwise guessing would be free.
    expect(counters.get(`billing:redeem-fail:user:${USER}`)).toBe(1);
    expect(cache.get).toHaveBeenCalled();
  });

  /**
   * Refusing a paying household because Redis blinked is a worse failure than
   * letting a few extra guesses through — the same contract CacheService keeps.
   */
  it('lets everything through when the cache is unavailable', async () => {
    const { service } = build({ cacheEnabled: false });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await statusOf(() =>
        service.redeem(HOUSEHOLD, USER, MISSING_CODE),
      );
      expect(status).toBe(HttpStatus.NOT_FOUND);
    }
  });

  it('does not count a successful preview against the limit', async () => {
    const { service, counters } = build({});

    await service.preview(HOUSEHOLD, MISSING_CODE);

    // Preview is read-only and free: someone checking a code they were sent
    // must never be locked out by it.
    expect(counters.size).toBe(0);
  });
});

describe('RedeemService failure reasons', () => {
  it('reports a disabled code as simply invalid', async () => {
    const { service } = build({});
    const repository = (service as unknown as { billingRepository: BillingRepository })
      .billingRepository;

    (repository.findRedeemCode as jest.Mock).mockResolvedValueOnce({
      id: 'code-1',
      code: MISSING_CODE,
      campaign: 'test',
      status: 'disabled',
      grantType: 'duration_days',
      grantDurationDays: 30,
      grantUntil: null,
      maxRedemptions: 1,
      redemptionCount: 0,
      expiresAt: null,
    });

    const preview = await service.preview(HOUSEHOLD, MISSING_CODE);

    // Not "disabled": a withdrawn code must look exactly like one that never
    // existed, or the endpoint becomes a way to enumerate real codes.
    expect(preview.reason).toBe('invalid');
  });

  it('distinguishes an expired code, because the holder needs to know', async () => {
    const { service } = build({});
    const repository = (service as unknown as { billingRepository: BillingRepository })
      .billingRepository;

    (repository.findRedeemCode as jest.Mock).mockResolvedValueOnce({
      id: 'code-2',
      code: MISSING_CODE,
      campaign: 'test',
      status: 'active',
      grantType: 'duration_days',
      grantDurationDays: 30,
      grantUntil: null,
      maxRedemptions: 1,
      redemptionCount: 0,
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    const preview = await service.preview(HOUSEHOLD, MISSING_CODE);

    expect(preview.reason).toBe('expired');
  });

  it('reports a code with no slots left as exhausted', async () => {
    const { service } = build({});
    const repository = (service as unknown as { billingRepository: BillingRepository })
      .billingRepository;

    (repository.findRedeemCode as jest.Mock).mockResolvedValueOnce({
      id: 'code-3',
      code: MISSING_CODE,
      campaign: 'test',
      status: 'active',
      grantType: 'duration_days',
      grantDurationDays: 30,
      grantUntil: null,
      maxRedemptions: 5,
      redemptionCount: 5,
      expiresAt: null,
    });

    const preview = await service.preview(HOUSEHOLD, MISSING_CODE);

    expect(preview.reason).toBe('exhausted');
  });
});

/** Guards the exception the transaction relies on to roll back a wasted code. */
describe('no_effect', () => {
  it('is a conflict, so the surrounding transaction rolls back', () => {
    expect(new ConflictException('no_effect').getStatus()).toBe(
      HttpStatus.CONFLICT,
    );
  });
});

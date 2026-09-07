import { resolveEntitlement, type SubscriptionRow } from './entitlement';
import { PLAN_LIMITS } from '../constants/plan-limits';

const HOUSEHOLD = 'hh-1';
const NOW = new Date('2026-09-07T10:00:00.000Z');

function row(over: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    tier: 'premium',
    status: 'active',
    currentPeriodEnd: new Date('2026-12-31T00:00:00.000Z'),
    source: 'payment',
    trialStartedAt: null,
    trialEndsAt: null,
    ...over,
  };
}

describe('resolveEntitlement', () => {
  it('treats a missing row as free', () => {
    const result = resolveEntitlement(HOUSEHOLD, null, NOW);

    expect(result.tier).toBe('free');
    expect(result.limits).toEqual(PLAN_LIMITS.free);
    expect(result.expiresAt).toBeNull();
    expect(result.trialUsed).toBe(false);
  });

  it('grants premium limits while the period is open', () => {
    const result = resolveEntitlement(HOUSEHOLD, row(), NOW);

    expect(result.limits).toEqual(PLAN_LIMITS.premium);
    expect(result.status).toBe('active');
    expect(result.isLifetime).toBe(false);
  });

  /**
   * The whole reason the 900s cache TTL is safe: the row can be stale, the
   * clock comparison cannot.
   */
  it('drops to free limits the moment the period has passed', () => {
    const expired = row({ currentPeriodEnd: new Date('2026-09-07T09:59:59.000Z') });

    const result = resolveEntitlement(HOUSEHOLD, expired, NOW);

    expect(result.limits).toEqual(PLAN_LIMITS.free);
    expect(result.status).toBe('expired');
  });

  it('keeps reporting tier premium after lapsing, so the UI can say it expired', () => {
    const expired = row({ currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z') });

    const result = resolveEntitlement(HOUSEHOLD, expired, NOW);

    expect(result.tier).toBe('premium');
    expect(result.status).toBe('expired');
    expect(result.limits).toEqual(PLAN_LIMITS.free);
  });

  it('treats a premium row with no end date as lifetime', () => {
    const result = resolveEntitlement(
      HOUSEHOLD,
      row({ currentPeriodEnd: null }),
      NOW,
    );

    expect(result.isLifetime).toBe(true);
    expect(result.limits).toEqual(PLAN_LIMITS.premium);
    expect(result.daysRemaining).toBeNull();
    expect(result.expiresAt).toBeNull();
  });

  it('rounds days remaining up, so a part-day still reads as a day', () => {
    const result = resolveEntitlement(
      HOUSEHOLD,
      row({ currentPeriodEnd: new Date('2026-09-07T21:00:00.000Z') }),
      NOW,
    );

    expect(result.daysRemaining).toBe(1);
  });

  it('never reports negative days for a lapsed plan', () => {
    const result = resolveEntitlement(
      HOUSEHOLD,
      row({ currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z') }),
      NOW,
    );

    expect(result.daysRemaining).toBe(0);
  });

  it('marks an active trial as a trial', () => {
    const result = resolveEntitlement(
      HOUSEHOLD,
      row({
        source: 'trial',
        trialStartedAt: new Date('2026-09-01T00:00:00.000Z'),
        trialEndsAt: new Date('2026-09-15T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-09-15T00:00:00.000Z'),
      }),
      NOW,
    );

    expect(result.isTrial).toBe(true);
    expect(result.trialUsed).toBe(true);
    expect(result.limits).toEqual(PLAN_LIMITS.premium);
  });

  it('still reports the trial as used once it has ended', () => {
    const result = resolveEntitlement(
      HOUSEHOLD,
      row({
        source: 'trial',
        trialStartedAt: new Date('2026-07-01T00:00:00.000Z'),
        trialEndsAt: new Date('2026-07-15T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-07-15T00:00:00.000Z'),
      }),
      NOW,
    );

    expect(result.trialUsed).toBe(true);
    expect(result.isTrial).toBe(false);
    expect(result.limits).toEqual(PLAN_LIMITS.free);
  });

  it('honours an explicitly expired status even inside the period', () => {
    const result = resolveEntitlement(HOUSEHOLD, row({ status: 'expired' }), NOW);

    expect(result.limits).toEqual(PLAN_LIMITS.free);
  });

  it('reports a free row as active, not expired', () => {
    const result = resolveEntitlement(
      HOUSEHOLD,
      row({ tier: 'free', currentPeriodEnd: null, source: null }),
      NOW,
    );

    expect(result.status).toBe('active');
    expect(result.limits).toEqual(PLAN_LIMITS.free);
  });
});

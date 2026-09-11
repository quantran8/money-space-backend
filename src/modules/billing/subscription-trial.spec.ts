import { HttpStatus } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import type { SubscriptionRow } from './domain/entitlement';
import type { BillingRepository } from './repositories/billing.repository.interface';
import { noopAnalytics } from '../../common/analytics/test-support/analytics.fixture';

const HOUSEHOLD = 'hh-1';
const NOW = new Date('2026-09-10T00:00:00.000Z');

function build(current: SubscriptionRow | null) {
  const upsertSubscription = jest.fn(async () => undefined);
  const repository = {
    lockSubscription: jest.fn(async () => current),
    upsertSubscription,
  } as unknown as BillingRepository;

  const entitlements = {
    invalidate: jest.fn(async () => undefined),
    forHousehold: jest.fn(async () => ({ householdId: HOUSEHOLD })),
  };

  const analytics = noopAnalytics();
  const service = new SubscriptionService(
    repository,
    entitlements as never,
    analytics,
  );
  return { service, upsertSubscription, entitlements, analytics };
}

function row(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    tier: 'free',
    status: 'active',
    currentPeriodEnd: null,
    source: null,
    trialStartedAt: null,
    trialEndsAt: null,
    ...overrides,
  };
}

async function statusOf(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
    return HttpStatus.OK;
  } catch (error) {
    return (error as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
}

describe('SubscriptionService.startTrial', () => {
  it('grants the trial to a household that has never had one', async () => {
    const { service, upsertSubscription, entitlements } = build(null);

    await service.startTrial(HOUSEHOLD, 14, NOW);

    expect(upsertSubscription).toHaveBeenCalledWith(HOUSEHOLD, {
      tier: 'premium',
      status: 'active',
      currentPeriodEnd: new Date('2026-09-24T00:00:00.000Z'),
      source: 'trial',
      trialStartedAt: NOW,
      trialEndsAt: new Date('2026-09-24T00:00:00.000Z'),
    });
    expect(entitlements.invalidate).toHaveBeenCalledWith(HOUSEHOLD);
  });

  it('refuses a second trial long after the first expired', async () => {
    const { service, upsertSubscription } = build(
      row({
        trialStartedAt: new Date('2026-07-01T00:00:00.000Z'),
        trialEndsAt: new Date('2026-07-15T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-07-15T00:00:00.000Z'),
        source: 'trial',
      }),
    );

    expect(await statusOf(() => service.startTrial(HOUSEHOLD, 14, NOW))).toBe(
      HttpStatus.CONFLICT,
    );
    expect(upsertSubscription).not.toHaveBeenCalled();
  });

  it('never downgrades a household that already paid', async () => {
    const { service, upsertSubscription } = build(
      row({ tier: 'premium', source: 'payment' }),
    );

    expect(await statusOf(() => service.startTrial(HOUSEHOLD, 14, NOW))).toBe(
      HttpStatus.CONFLICT,
    );
    expect(upsertSubscription).not.toHaveBeenCalled();
  });

  it('refuses instead of burning the trial when trials are switched off', async () => {
    const { service, upsertSubscription } = build(null);

    expect(await statusOf(() => service.startTrial(HOUSEHOLD, 0, NOW))).toBe(
      HttpStatus.CONFLICT,
    );
    expect(upsertSubscription).not.toHaveBeenCalled();
  });
});

import { Inject, Injectable } from '@nestjs/common';
import { billingConfig } from '../../config/billing.config';
import { CacheService } from '../../common/cache/cache.service';
import { WhatIfUsageService } from './whatif-usage.service';
import { cacheKeys, cacheTtl } from '../../common/cache/cache.keys';
import { resolveEntitlement, type SubscriptionRow } from './domain/entitlement';
import {
  PremiumRequiredException,
  type PaywallReason,
} from './entitlement.errors';
import type {
  CountableQuota,
  Entitlement,
} from './entities/entitlement.entity';
import {
  BILLING_REPOSITORY,
  type BillingRepository,
} from './repositories/billing.repository.interface';
import { AnalyticsService } from '../../common/analytics/analytics.service';

/**
 * Short, because a plan changes while the household is looking at the screen.
 * The in-process layer exists because entitlement is read on every gated
 * request in Phase 3, and a 1-2ms Redis round-trip per request is not worth
 * paying when `CacheService` already budgets 250ms for a bad one.
 */
const MEMORY_TTL_MS = 30_000;

type CachedRow = {
  row: SubscriptionRow | null;
};

/** Dates do not survive JSON, so they are restored on the way out of Redis. */
function reviveRow(cached: CachedRow): SubscriptionRow | null {
  const { row } = cached;
  if (!row) return null;

  return {
    ...row,
    currentPeriodEnd: row.currentPeriodEnd ? new Date(row.currentPeriodEnd) : null,
    trialStartedAt: row.trialStartedAt ? new Date(row.trialStartedAt) : null,
    trialEndsAt: row.trialEndsAt ? new Date(row.trialEndsAt) : null,
  };
}

/**
 * Reads what a household is currently entitled to. The one chokepoint — guards,
 * services and crons all come through here.
 *
 * What is cached is the stored ROW, never the resolved answer: the comparison
 * against `now` runs on every call inside `resolveEntitlement`. That is what
 * lets the cache live for fifteen minutes without anyone getting fifteen
 * minutes of Premium they no longer have.
 */
@Injectable()
export class EntitlementService {
  constructor(
    @Inject(BILLING_REPOSITORY)
    private readonly billingRepository: BillingRepository,
    private readonly cache: CacheService,
    private readonly whatIfUsage: WhatIfUsageService,
    private readonly analytics: AnalyticsService,
  ) {}

  private readonly memory = new Map<
    string,
    { value: SubscriptionRow | null; expiresAt: number }
  >();

  /** Never throws: a household with no row is simply on the free plan. */
  async forHousehold(householdId: string, now = new Date()): Promise<Entitlement> {
    const row = await this.loadRow(householdId);
    return resolveEntitlement(householdId, row, now, billingConfig.trialDays);
  }

  /**
   * The same answer plus current consumption of the counted quotas. Separate
   * because it costs two extra queries, and almost nothing needs it — only the
   * screen that draws "2/2 mục tiêu".
   */
  async forHouseholdWithUsage(
    householdId: string,
    now = new Date(),
  ): Promise<Entitlement> {
    const [entitlement, counts, whatIfThisMonth] = await Promise.all([
      this.forHousehold(householdId, now),
      this.billingRepository.countUsage(householdId),
      // A Redis read, not a query — what-if writes no rows, deliberately. See
      // `WhatIfUsageService` for why, and note it fails open to 0.
      this.whatIfUsage.used(householdId),
    ]);

    return {
      ...entitlement,
      usage: { ...counts, whatIfThisMonth },
    };
  }

  /**
   * Enforce a counted quota. `used` is supplied by the caller, which has
   * already queried it — a guard cannot count without a second round trip,
   * which is why counted limits are checked here and not in one.
   *
   * `null` means unlimited, so premium never reaches the comparison.
   */
  assertQuota(
    entitlement: Entitlement,
    quota: CountableQuota,
    used: number,
    reason: PaywallReason,
  ): void {
    const limit = entitlement.limits[quota];
    if (limit === null || used < limit) return;

    // Emitted HERE rather than at the two call sites: this is the only place a
    // counted wall is decided, so a third quota is measured the day it is
    // added. Synchronous and fail-open, so it cannot change what is thrown.
    this.analytics.capture(entitlement.householdId, 'paywall_hit', {
      reason,
      tier: entitlement.tier,
      limit,
      used,
      household_age_days: null,
    });

    throw new PremiumRequiredException(reason, entitlement, { limit, used });
  }

  /**
   * Drop both cache layers for one household. Called only by whatever changes a
   * plan — never by the household-wide invalidation, which fires on every write
   * and has nothing to do with subscriptions.
   */
  async invalidate(householdId: string): Promise<void> {
    this.memory.delete(householdId);
    await this.cache.del(cacheKeys.entitlement(householdId));
  }

  private async loadRow(householdId: string): Promise<SubscriptionRow | null> {
    const cached = this.memory.get(householdId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const key = cacheKeys.entitlement(householdId);
    const fromRedis = await this.cache.get<CachedRow>(key);

    if (fromRedis) {
      const row = reviveRow(fromRedis);
      this.remember(householdId, row);
      return row;
    }

    const row = await this.billingRepository.findSubscription(householdId);
    // A missing row is cached too — "this household is on free" is an answer
    // worth not re-querying, and it is the common case.
    await this.cache.set<CachedRow>(key, { row }, cacheTtl.entitlement);
    this.remember(householdId, row);
    return row;
  }

  private remember(householdId: string, value: SubscriptionRow | null) {
    this.memory.set(householdId, {
      value,
      expiresAt: Date.now() + MEMORY_TTL_MS,
    });
  }
}

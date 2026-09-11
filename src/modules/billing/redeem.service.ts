import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CacheInvalidator } from '../../common/cache/cache-invalidator.service';
import { CacheService } from '../../common/cache/cache.service';
import { EntitlementService } from './entitlement.service';
import { SubscriptionService } from './subscription.service';
import { extendPeriod, type Grant } from './domain/extend-period';
import {
  isValidRedeemCode,
  normalizeRedeemCode,
} from './domain/redeem-code-format';
import type {
  RedeemCodePreview,
  RedeemCodeResult,
  RedeemFailureReason,
} from './dto/redeem-code.dto';
import {
  BILLING_REPOSITORY,
  type BillingRepository,
  type RedeemCodeRow,
} from './repositories/billing.repository.interface';
import { isUniqueViolation } from '../../common/repositories/prisma-errors';
import { AnalyticsService } from '../../common/analytics/analytics.service';

/** Failures per hour, per user and per household, before the door closes. */
const MAX_FAILURES_PER_HOUR = 10;
const FAILURE_WINDOW_SECONDS = 60 * 60;

class RedeemRateLimitedException extends HttpException {
  constructor() {
    super(
      { message: 'redeem_rate_limited', error: 'TooManyRequests' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class RedeemService {
  constructor(
    @Inject(BILLING_REPOSITORY)
    private readonly billingRepository: BillingRepository,
    private readonly subscriptions: SubscriptionService,
    private readonly entitlements: EntitlementService,
    private readonly cacheInvalidator: CacheInvalidator,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * What this code would do, without spending it.
   *
   * Worth a separate call because redeeming cannot be undone and codes are
   * typed off a Zalo screenshot. It also names the household, which is what
   * saves someone who belongs to two of them from activating the wrong one.
   */
  async preview(
    householdId: string,
    rawCode: string,
    now = new Date(),
  ): Promise<RedeemCodePreview> {
    const code = normalizeRedeemCode(rawCode);
    const householdName =
      await this.billingRepository.findHouseholdName(householdId);

    const fail = (reason: RedeemFailureReason): RedeemCodePreview => ({
      code,
      valid: false,
      reason,
      householdName,
      grant: null,
    });

    if (!isValidRedeemCode(code)) return fail('invalid');

    const row = await this.billingRepository.findRedeemCode(code);
    const rejection = this.rejectionFor(row, now);
    if (rejection) return fail(rejection);

    if (await this.billingRepository.hasRedeemed(row!.id, householdId)) {
      return fail('already_used');
    }

    const subscription = await this.billingRepository.findSubscription(householdId);
    const result = extendPeriod({
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      isLifetime:
        subscription?.tier === 'premium' && subscription.currentPeriodEnd === null,
      now,
      grant: this.grantOf(row!),
    });

    // Valid, but it would take nothing away and add nothing either. Reported so
    // the client can say so and let the household keep the code.
    if (result.noop) {
      return { ...fail('no_effect'), valid: false };
    }

    return {
      code,
      valid: true,
      reason: null,
      householdName,
      grant: {
        addedDays: result.addedDays,
        periodEndAfter: result.periodEnd?.toISOString() ?? null,
        stacked: result.stacked,
        isLifetime: result.periodEnd === null,
      },
    };
  }

  /**
   * Spend the code.
   *
   * Three barriers, all in the database rather than in app-level `if`s:
   * claiming a slot is a conditional UPDATE, the redemption row has a unique
   * constraint on (code, household), and the subscription row is locked FOR
   * UPDATE while the new expiry is computed.
   */
  async redeem(
    householdId: string,
    userId: string,
    rawCode: string,
    now = new Date(),
  ): Promise<RedeemCodeResult> {
    await this.assertNotRateLimited(userId, householdId);

    const code = normalizeRedeemCode(rawCode);

    // Rejected before touching the database — a malformed code cannot exist.
    if (!isValidRedeemCode(code)) {
      await this.recordFailure(userId, householdId);
      throw new BadRequestException('invalid');
    }

    const row = await this.billingRepository.findRedeemCode(code);
    const rejection = this.rejectionFor(row, now);
    if (rejection) {
      await this.recordFailure(userId, householdId);
      if (rejection === 'invalid') throw new NotFoundException('invalid');
      throw new ConflictException(rejection);
    }

    const grant = this.grantOf(row!);

    // Commit first, then drop the cache — and on rollback, drop nothing.
    await this.cacheInvalidator.runInTransactionAndInvalidate(
      householdId,
      async () => {
        // Barrier 1: the code still has a slot.
        const claimed = await this.billingRepository.claimRedeemCodeSlot(row!.id);
        if (!claimed) throw new ConflictException('exhausted');

        // Barrier 2: this household has not used this code. The unique index
        // is what decides it, so two simultaneous requests cannot both pass.
        try {
          await this.billingRepository.insertRedemption({
            redeemCodeId: row!.id,
            householdId,
            redeemedById: userId,
            grantedDays: null,
            periodEndBefore: null,
            periodEndAfter: null,
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictException('already_used');
          }
          throw error;
        }

        // Barrier 3 lives inside grantOrExtend: it locks the subscription row
        // before reading the expiry, so two grants cannot both extend from the
        // same starting point.
        const result = await this.subscriptions.grantOrExtend(
          householdId,
          grant,
          'redeem_code',
          now,
        );

        if (result.noop) {
          // Nothing was added — usually a lifetime household, or an until_date
          // code behind the current expiry. Roll back so the code is not spent.
          throw new ConflictException('no_effect');
        }

        await this.billingRepository.updateRedemptionOutcome(row!.id, householdId, {
          grantedDays: result.addedDays,
          periodEndBefore: result.periodEndBefore,
          periodEndAfter: result.periodEnd,
        });

        await this.audit.record(householdId, {
          actorId: userId,
          action: 'subscription.redeemed',
          entityType: 'household_subscription',
          entityId: row!.id,
          details: {
            campaign: row!.campaign,
            addedDays: result.addedDays,
            lifetime: result.periodEnd === null,
          },
        });
      },
    );

    const entitlement = await this.entitlements.forHousehold(householdId, now);
    const addedDays = entitlement.isLifetime
      ? 0
      : this.daysBetween(now, entitlement.expiresAt);

    // After the transaction commits: a `no_effect` code throws above and is
    // rolled back, so reaching here means the grant actually landed.
    // `campaign` is the attribution field — which batch brought this household.
    this.analytics.capture(
      householdId,
      'code_redeemed',
      {
        campaign: row!.campaign,
        grant_type: row!.grantType,
        added_days: addedDays,
        lifetime: entitlement.isLifetime,
      },
      userId,
    );

    return { redeemed: true, code, addedDays, entitlement };
  }

  /** Why the code cannot be used, or `null` when it can. */
  private rejectionFor(
    row: RedeemCodeRow | null,
    now: Date,
  ): RedeemFailureReason | null {
    // A disabled code is indistinguishable from one that never existed.
    if (!row || row.status === 'disabled') return 'invalid';
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'expired';
    if (row.status === 'exhausted' || row.redemptionCount >= row.maxRedemptions) {
      return 'exhausted';
    }
    return null;
  }

  private grantOf(row: RedeemCodeRow): Grant {
    switch (row.grantType) {
      case 'lifetime':
        return { type: 'lifetime' };
      case 'until_date':
        if (!row.grantUntil) throw new BadRequestException('invalid');
        return { type: 'until_date', until: row.grantUntil };
      case 'duration_days':
        if (!row.grantDurationDays) throw new BadRequestException('invalid');
        return { type: 'duration_days', days: row.grantDurationDays };
    }
  }

  private daysBetween(from: Date, isoTo: string | null): number {
    if (!isoTo) return 0;
    const ms = new Date(isoTo).getTime() - from.getTime();
    return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  }

  /**
   * Rate limiting without `@nestjs/throttler`: one endpoint does not justify a
   * dependency, a global module and a second Redis store. Built on
   * `CacheService.incr`, which fails open — refusing a paying household because
   * Redis blinked is worse than letting a few extra guesses through.
   *
   * Keyed by userId rather than IP: Vietnamese mobile carriers NAT heavily, so
   * an IP key would block real people. Every route here is authenticated, so an
   * attacker needs a fresh verified account for each ten attempts.
   */
  private async assertNotRateLimited(userId: string, householdId: string) {
    const [byUser, byHousehold] = await Promise.all([
      this.cache.get<number>(this.failureKey('user', userId)),
      this.cache.get<number>(this.failureKey('household', householdId)),
    ]);

    if (
      (byUser ?? 0) >= MAX_FAILURES_PER_HOUR ||
      (byHousehold ?? 0) >= MAX_FAILURES_PER_HOUR
    ) {
      throw new RedeemRateLimitedException();
    }
  }

  /** Only FAILURES count, so buying five codes at once is never penalised. */
  private async recordFailure(userId: string, householdId: string) {
    await Promise.all([
      this.cache.incr(this.failureKey('user', userId), FAILURE_WINDOW_SECONDS),
      this.cache.incr(
        this.failureKey('household', householdId),
        FAILURE_WINDOW_SECONDS,
      ),
    ]);
  }

  private failureKey(scope: 'user' | 'household', id: string) {
    return `billing:redeem-fail:${scope}:${id}`;
  }
}


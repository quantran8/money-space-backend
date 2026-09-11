import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { withAdvisoryLock } from '../../common/utils/advisory-lock';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AnalyticsService } from '../../common/analytics/analytics.service';
import { EntitlementService } from './entitlement.service';
import {
  BILLING_REPOSITORY,
  type BillingRepository,
} from './repositories/billing.repository.interface';

/** Leftovers resume on the next run. */
const DEFAULT_BATCH_LIMIT = 500;

/** Invalidation is one Redis DEL each; kept below the pool budget anyway. */
const INVALIDATE_CONCURRENCY = 10;

export interface ExpirySweepResult {
  subscriptions: number;
  orders: number;
}

/**
 * The daily sweep that ends what has run out: lapsed subscriptions and
 * unpaid checkouts.
 *
 * Both halves are idempotent — a second run finds nothing left to flip — which
 * is what makes an advisory lock (advisory, not exactly-once) the right guard.
 * See `memory/billing-and-entitlement.md`.
 */
@Injectable()
export class BillingExpiryCron {
  /** Cluster-wide lock name; see `withAdvisoryLock`. */
  private static readonly LOCK_NAME = 'billing:expiry-sweep';

  private readonly logger = new Logger(BillingExpiryCron.name);
  private running = false;

  constructor(
    @Inject(BILLING_REPOSITORY)
    private readonly billingRepository: BillingRepository,
    private readonly entitlements: EntitlementService,
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** 09:00 VN, not 23:45 like the valuation job: a notice has to land awake. */
  @Cron('0 9 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async sweepExpired(): Promise<void> {
    if (process.env.BILLING_EXPIRY_CRON_ENABLED === 'false') return;
    await this.run();
  }

  /** Separate from the scheduled method so it can be driven directly. */
  async run(): Promise<ExpirySweepResult> {
    // Per-process guard; the advisory lock below covers other instances.
    if (this.running) {
      this.logger.warn('Billing expiry already running — skipping this tick');
      return { subscriptions: 0, orders: 0 };
    }
    this.running = true;

    try {
      const result = await withAdvisoryLock(
        this.prisma,
        BillingExpiryCron.LOCK_NAME,
        () => this.sweepAll(),
      );
      if (!result) {
        this.logger.log(
          'Billing expiry: another instance holds the lock — skipping',
        );
        return { subscriptions: 0, orders: 0 };
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /** The actual sweep, once this instance holds the lock. */
  private async sweepAll(): Promise<ExpirySweepResult> {
    const startedAt = Date.now();
    // Resolved once so both halves agree on where the cutoff is.
    const now = new Date();
    const limit = this.batchLimit();

    const subscriptions = await this.expireSubscriptions(now, limit);
    const orders = await this.expireOrders(now, limit);

    this.logger.log(
      `Billing expiry: ${subscriptions} subscription(s), ${orders} order(s), ` +
        `${Date.now() - startedAt}ms`,
    );
    return { subscriptions, orders };
  }

  private async expireSubscriptions(
    now: Date,
    limit: number,
  ): Promise<number> {
    let householdIds: string[];
    try {
      householdIds = await this.billingRepository.expireLapsedSubscriptions(
        now,
        limit,
      );
    } catch (error) {
      // The order half is independent, so one failure must not abort the sweep.
      this.logger.error(
        `Billing expiry: subscription sweep failed: ${message(error)}`,
      );
      return 0;
    }

    // The rows are already flipped; a cache left holding the old row would
    // serve Premium for up to its TTL. A failure here is logged and skipped
    // rather than retried — the entry expires on its own, and `resolveEntitlement`
    // re-checks `currentPeriodEnd` against `now` on every read anyway.
    let failed = 0;
    for (const chunk of chunked(householdIds, INVALIDATE_CONCURRENCY)) {
      await Promise.all(
        chunk.map(async (householdId) => {
          try {
            await this.entitlements.invalidate(householdId);
          } catch (error) {
            failed += 1;
            this.logger.error(
              `Billing expiry: could not invalidate ${householdId}: ${message(error)}`,
            );
          }
        }),
      );
    }

    if (failed > 0) {
      this.logger.warn(
        `Billing expiry: ${failed} entitlement cache(s) not invalidated`,
      );
    }

    // Churn had no trace anywhere before this: the sweep flips the rows and
    // wrote nothing. The flags are unknown from the sweep's own query, so they
    // are left null rather than guessed. See memory/billing-and-entitlement.md.
    for (const householdId of householdIds) {
      this.analytics.capture(householdId, 'subscription_expired', {
        was_trial: false,
        plan_source: null,
      });
    }

    return householdIds.length;
  }

  private async expireOrders(now: Date, limit: number): Promise<number> {
    try {
      return await this.billingRepository.expireStalePaymentOrders(now, limit);
    } catch (error) {
      this.logger.error(
        `Billing expiry: order sweep failed: ${message(error)}`,
      );
      return 0;
    }
  }

  private batchLimit(): number {
    const raw = Number(process.env.BILLING_EXPIRY_BATCH_LIMIT);
    return Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : DEFAULT_BATCH_LIMIT;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

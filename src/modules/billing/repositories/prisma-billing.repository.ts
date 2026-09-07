import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { uuidv7 } from '../../../common/utils/uuid';
import type { SubscriptionRow } from '../domain/entitlement';
import type { EntitlementUsage } from '../entities/entitlement.entity';
import type {
  BillingRepository,
  PaymentOrderRow,
  PaymentOrderWrite,
  RedeemCodeRow,
  RedemptionWrite,
  RevenuecatSubscriberRow,
  StorePurchaseWrite,
  SubscriptionWrite,
} from './billing.repository.interface';

const SUBSCRIPTION_FIELDS = {
  tier: true,
  status: true,
  currentPeriodEnd: true,
  source: true,
  trialStartedAt: true,
  trialEndsAt: true,
} as const;


const PAYMENT_ORDER_FIELDS = {
  id: true,
  householdId: true,
  status: true,
  orderCode: true,
  planCode: true,
  amount: true,
  durationDays: true,
  providerTxnId: true,
  checkoutUrl: true,
  createdAt: true,
  paidAt: true,
  provider: true,
  store: true,
  productId: true,
  storeExpiresAt: true,
} as const;

@Injectable()
export class PrismaBillingRepository
  extends PrismaRepository
  implements BillingRepository
{
  constructor(prismaService: PrismaService) {
    super(prismaService);
  }

  async findSubscription(householdId: string): Promise<SubscriptionRow | null> {
    const row = await this.prisma.householdSubscription.findUnique({
      where: { householdId },
      select: SUBSCRIPTION_FIELDS,
    });

    return row ?? null;
  }

  async lockSubscription(householdId: string): Promise<SubscriptionRow | null> {
    // Prisma has no FOR UPDATE, so the lock is taken with raw SQL. It only
    // holds inside a transaction — outside one this degrades to a plain read,
    // which is why every caller runs it within `runInTransaction`.
    const rows = await this.prisma.$queryRaw<
      Array<{
        tier: SubscriptionRow['tier'];
        status: SubscriptionRow['status'];
        current_period_end: Date | null;
        source: SubscriptionRow['source'];
        trial_started_at: Date | null;
        trial_ends_at: Date | null;
      }>
    >`
      SELECT tier, status, current_period_end, source, trial_started_at, trial_ends_at
      FROM household_subscriptions
      WHERE household_id = ${householdId}::uuid
      FOR UPDATE
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      tier: row.tier,
      status: row.status,
      currentPeriodEnd: row.current_period_end,
      source: row.source,
      trialStartedAt: row.trial_started_at,
      trialEndsAt: row.trial_ends_at,
    };
  }

  async upsertSubscription(
    householdId: string,
    write: SubscriptionWrite,
  ): Promise<void> {
    await this.prisma.householdSubscription.upsert({
      where: { householdId },
      create: { id: uuidv7(), householdId, ...write },
      // Trial stamps are only ever set, never cleared by a later grant: having
      // used a trial has to survive upgrading to a paid plan.
      update: {
        tier: write.tier,
        status: write.status,
        currentPeriodEnd: write.currentPeriodEnd,
        source: write.source,
        ...(write.trialStartedAt ? { trialStartedAt: write.trialStartedAt } : {}),
        ...(write.trialEndsAt ? { trialEndsAt: write.trialEndsAt } : {}),
      },
    });
  }

  async countUsage(
    householdId: string,
  ): Promise<Omit<EntitlementUsage, 'whatIfThisMonth'>> {
    const [goals, marketPricedAssets] = await Promise.all([
      // Only ACTIVE goals occupy a slot. Counting completed ones would mean a
      // household that reached two goals could never start a third — punishing
      // them for succeeding.
      this.prisma.financialGoal.count({
        where: { householdId, status: 'active', deletedAt: null },
      }),
      this.prisma.asset.count({
        where: {
          householdId,
          valuationMode: 'market_priced',
          status: 'active',
          deletedAt: null,
        },
      }),
    ]);

    return { goals, marketPricedAssets };
  }

  async findHouseholdName(householdId: string): Promise<string> {
    const row = await this.prisma.household.findUnique({
      where: { id: householdId },
      select: { name: true },
    });

    return row?.name ?? '';
  }

  async findRedeemCode(code: string): Promise<RedeemCodeRow | null> {
    const row = await this.prisma.redeemCode.findUnique({
      where: { code },
      select: {
        id: true,
        code: true,
        campaign: true,
        status: true,
        grantType: true,
        grantDurationDays: true,
        grantUntil: true,
        maxRedemptions: true,
        redemptionCount: true,
        expiresAt: true,
        deletedAt: true,
      },
    });

    // A withdrawn code is indistinguishable from one that never existed.
    if (!row || row.deletedAt) return null;

    const { deletedAt: _deletedAt, ...rest } = row;
    return rest;
  }

  async hasRedeemed(redeemCodeId: string, householdId: string): Promise<boolean> {
    const existing = await this.prisma.redeemCodeRedemption.findUnique({
      where: {
        redeemCodeId_householdId: { redeemCodeId, householdId },
      },
      select: { id: true },
    });

    return existing !== null;
  }

  async claimRedeemCodeSlot(codeId: string): Promise<boolean> {
    // Every condition sits in the WHERE clause, so Postgres locks the row and
    // re-evaluates them for a second transaction after the first commits. Two
    // people redeeming the last slot together: one gets the row, the other gets
    // zero rows affected. No SELECT ... FOR UPDATE and no advisory lock needed.
    const affected = await this.prisma.$executeRaw`
      UPDATE redeem_codes
      SET redemption_count = redemption_count + 1,
          status = CASE
            WHEN redemption_count + 1 >= max_redemptions THEN 'exhausted'::"RedeemCodeStatus"
            ELSE status
          END,
          updated_at = now()
      WHERE id = ${codeId}::uuid
        AND status = 'active'
        AND deleted_at IS NULL
        AND redemption_count < max_redemptions
        AND (expires_at IS NULL OR expires_at > now())
    `;

    return affected === 1;
  }

  async insertRedemption(write: RedemptionWrite): Promise<void> {
    await this.prisma.redeemCodeRedemption.create({
      data: { id: uuidv7(), ...write },
    });
  }

  async insertPaymentOrder(write: PaymentOrderWrite): Promise<void> {
    await this.prisma.paymentOrder.create({ data: write });
  }

  async attachCheckout(
    orderCode: bigint,
    checkout: { checkoutUrl: string; providerOrderId: string },
  ): Promise<void> {
    await this.prisma.paymentOrder.update({
      where: { orderCode },
      data: checkout,
    });
  }

  async findPaymentOrderByCode(
    orderCode: bigint,
  ): Promise<PaymentOrderRow | null> {
    return this.prisma.paymentOrder.findUnique({
      where: { orderCode },
      select: PAYMENT_ORDER_FIELDS,
    });
  }

  async listPaymentOrders(
    householdId: string,
    limit: number,
  ): Promise<PaymentOrderRow[]> {
    return this.prisma.paymentOrder.findMany({
      where: { householdId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: PAYMENT_ORDER_FIELDS,
    });
  }

  async markPaymentOrderPaid(
    orderCode: bigint,
    settlement: { providerTxnId: string; paidAt: Date; rawPayload: unknown },
  ): Promise<boolean> {
    // `status: 'pending'` in the WHERE, not an app-level `if`: Postgres
    // re-evaluates it for the second transaction after the first commits, so
    // two simultaneous deliveries cannot both match. `updateMany` rather than
    // `update` because a miss must be a count of 0, not a thrown NotFound.
    const result = await this.prisma.paymentOrder.updateMany({
      where: { orderCode, status: 'pending' },
      data: {
        status: 'paid',
        providerTxnId: settlement.providerTxnId,
        paidAt: settlement.paidAt,
        rawPayload: settlement.rawPayload as never,
      },
    });

    return result.count === 1;
  }

  async expireLapsedSubscriptions(now: Date, limit: number): Promise<string[]> {
    // Select and flip in one statement: RETURNING gives back exactly the rows
    // this run changed, which is what the cron invalidates. LIMIT chunks it;
    // leftovers wait for the next run. See memory/billing-and-entitlement.md.
    const rows = await this.prisma.$queryRaw<Array<{ household_id: string }>>`
      UPDATE household_subscriptions
      SET status = 'expired'::"SubscriptionStatus",
          updated_at = now()
      WHERE id IN (
        SELECT id FROM household_subscriptions
        WHERE tier = 'premium'::"SubscriptionTier"
          AND status = 'active'::"SubscriptionStatus"
          AND current_period_end < ${now}
        ORDER BY current_period_end ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING household_id
    `;

    return rows.map((row) => row.household_id);
  }

  async expireStalePaymentOrders(now: Date, limit: number): Promise<number> {
    // `status = 'pending'` in the WHERE: an order the webhook settles mid-sweep
    // is re-checked by Postgres and left alone.
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE payment_orders
      SET status = 'expired'::"PaymentOrderStatus",
          updated_at = now()
      WHERE id IN (
        SELECT id FROM payment_orders
        WHERE status = 'pending'::"PaymentOrderStatus"
          AND expires_at < ${now}
        ORDER BY expires_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;

    return rows.length;
  }

  async markPaymentOrderClosed(
    orderCode: bigint,
    status: 'cancelled' | 'expired',
  ): Promise<void> {
    // Only a pending order can be closed — a paid one must never be walked
    // back by a late cancellation callback.
    await this.prisma.paymentOrder.updateMany({
      where: { orderCode, status: 'pending' },
      data: { status },
    });
  }

  async recordPaymentPayload(
    orderCode: bigint,
    rawPayload: unknown,
  ): Promise<void> {
    await this.prisma.paymentOrder.updateMany({
      where: { orderCode },
      data: { rawPayload: rawPayload as never },
    });
  }

  async updateRedemptionOutcome(
    redeemCodeId: string,
    householdId: string,
    outcome: {
      grantedDays: number;
      periodEndBefore: Date | null;
      periodEndAfter: Date | null;
    },
  ): Promise<void> {
    await this.prisma.redeemCodeRedemption.update({
      where: { redeemCodeId_householdId: { redeemCodeId, householdId } },
      data: outcome,
    });
  }

  async insertStorePurchase(write: StorePurchaseWrite): Promise<void> {
    // No `pending` step and no order code: the store has already taken the
    // money by the time RevenueCat tells us, so the row is born paid.
    //
    // A duplicate `providerTxnId` throws here on purpose. The caller catches
    // the unique violation and treats it as "already handled" — checking first
    // would leave a window in which two deliveries both pass the check.
    await this.prisma.paymentOrder.create({
      data: {
        id: write.id,
        householdId: write.householdId,
        createdById: write.createdById,
        provider: 'revenuecat',
        status: 'paid',
        planCode: write.planCode,
        amountOriginal: write.amount,
        discountAmount: 0,
        amount: write.amount,
        durationDays: write.durationDays,
        providerTxnId: write.providerTxnId,
        providerUserId: write.providerUserId,
        productId: write.productId,
        store: write.store,
        storeExpiresAt: write.storeExpiresAt,
        paidAt: write.paidAt,
        rawPayload: write.rawPayload as never,
      },
    });
  }

  async findRevenuecatSubscriber(
    providerUserIds: string[],
  ): Promise<RevenuecatSubscriberRow | null> {
    if (providerUserIds.length === 0) return null;

    return this.prisma.revenuecatSubscriber.findFirst({
      where: { providerUserId: { in: providerUserIds } },
      select: { providerUserId: true, profileId: true, householdId: true },
    });
  }

  async linkRevenuecatSubscriber(link: {
    providerUserId: string;
    profileId: string | null;
    householdId: string;
  }): Promise<void> {
    await this.prisma.revenuecatSubscriber.upsert({
      where: { providerUserId: link.providerUserId },
      create: { id: uuidv7(), ...link },
      // `householdId` is deliberately NOT updated: a member who later joins a
      // different household must not have their running subscription silently
      // start paying for the new one.
      update: { profileId: link.profileId },
    });
  }
}

import { billingConfig } from '../../../config/billing.config';
import {
  PLAN_CATALOG,
  PLAN_CODES,
  YEARLY_REFERENCE_VND,
  type PlanCode,
} from '../constants/plan-catalog';

export interface PlanOffer {
  planCode: PlanCode;
  /** List price before any discount. */
  amountOriginal: number;
  /** What the household actually pays. */
  amount: number;
  discountAmount: number;
  discountPercent: number;
  /** Campaign badge, or `null` when nothing is running. */
  discountLabel: string | null;
  /**
   * For the yearly plan: what is saved against twelve monthly payments, after
   * any discount. `null` for the other plans, which have nothing to compare to.
   */
  savingsAmount: number | null;
  /** Price per month implied by this plan, rounded to the nearest 1.000đ. */
  monthlyEquivalent: number | null;
  /** Reference price shown struck through. `null` when there is nothing to strike. */
  compareAtAmount: number | null;
  /** `null` = lifetime. */
  durationDays: number | null;
  /** False when the plan is not currently for sale. */
  available: boolean;
}

/** Vietnamese prices are never quoted in single dong. */
function roundToThousand(value: number): number {
  return Math.round(value / 1000) * 1000;
}

/** Whether a discount campaign is running at `now`. */
function campaignActive(now: Date): boolean {
  const { discountStartsAt, discountEndsAt } = billingConfig;

  if (discountStartsAt) {
    const start = new Date(discountStartsAt);
    if (!Number.isNaN(start.getTime()) && now < start) return false;
  }
  if (discountEndsAt) {
    const end = new Date(discountEndsAt);
    if (!Number.isNaN(end.getTime()) && now > end) return false;
  }
  return true;
}

/**
 * Every price in the product — the paywall, an order, the landing page — comes
 * from here.
 *
 * Pure and given `now` explicitly so a scheduled campaign is testable without
 * mocking the clock, matching how the forecast engines take `asOfDate`.
 */
export function buildPlanOffers(now: Date): PlanOffer[] {
  const active = campaignActive(now);

  return PLAN_CODES.map((planCode) => {
    const plan = PLAN_CATALOG[planCode];
    const discountPercent = active
      ? billingConfig.discountPercent[planCode]
      : 0;

    const discountAmount = roundToThousand(
      (plan.amountVnd * discountPercent) / 100,
    );
    const amount = plan.amountVnd - discountAmount;

    const isYearly = planCode === 'premium_yearly';

    return {
      planCode,
      amountOriginal: plan.amountVnd,
      amount,
      discountAmount,
      discountPercent,
      discountLabel:
        discountPercent > 0 && billingConfig.discountLabel
          ? billingConfig.discountLabel
          : null,
      // Against twelve monthly payments, not against the list price — that is
      // the comparison someone choosing between the two plans is making.
      savingsAmount: isYearly ? YEARLY_REFERENCE_VND - amount : null,
      monthlyEquivalent: plan.durationDays
        ? roundToThousand(amount / (plan.durationDays / 30))
        : null,
      // Only the yearly plan has a natural reference (12 × monthly). A
      // discounted plan strikes through its own list price instead.
      compareAtAmount: isYearly
        ? YEARLY_REFERENCE_VND
        : discountAmount > 0
          ? plan.amountVnd
          : null,
      durationDays: plan.durationDays,
      available:
        planCode === 'premium_lifetime' ? billingConfig.lifetimeEnabled : true,
    };
  });
}

/** One offer by code, or `undefined` when it is not currently for sale. */
export function findAvailableOffer(
  planCode: PlanCode,
  now: Date,
): PlanOffer | undefined {
  return buildPlanOffers(now).find(
    (offer) => offer.planCode === planCode && offer.available,
  );
}

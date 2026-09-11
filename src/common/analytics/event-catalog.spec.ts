import { SENSITIVE_KEYS } from '../../config/logger.config';
import {
  ALLOWED_PROPERTY_EXCEPTIONS,
  ANALYTICS_EVENT_NAMES,
  BANNED_PROPERTY_FRAGMENTS,
} from './event-catalog';
import { PAYWALL_REASONS, isPaywallReason } from './paywall-reason';

/**
 * The promise this file enforces: a couple's figures never leave the server.
 *
 * `SafeProps` already deletes a banned key at compile time, so a property
 * called `amount` cannot be written at all. What a TYPE cannot check is a
 * VALUE — a real balance hiding under a blandly-named key — which is what the
 * payload scan below is for.
 */
describe('analytics event catalog', () => {
  /**
   * One representative payload per event, kept in the same shape the services
   * emit. A new event with no sample here fails the completeness test, which is
   * what stops the scan from silently covering less over time.
   */
  const SAMPLE_PAYLOADS: Record<string, Record<string, unknown>> = {
    app_opened: { platform: 'ios', minutes_since_last_open: 47 },
    paywall_shown: { reason: 'manage', limit: null, used: null },
    signed_out: {},
    household_created: { update_frequency: 'weekly', partner_invited: true },
    member_joined: {
      method: 'invite',
      member_index: 2,
      hours_since_household_created: 18,
      already_member: false,
    },
    paywall_hit: {
      reason: 'goal_quota',
      tier: 'free',
      limit: 2,
      used: 2,
      household_age_days: 9,
    },
    auto_price_declined: {
      reason: 'auto_price_quota',
      asset_type: 'gold',
      limit: 1,
      used: 1,
    },
    what_if_run: {
      source: 'home',
      rerun: false,
      has_goal: true,
      has_asset_sale: false,
      amount_bucket: '10-50M',
      result_type: 'tight',
    },
    what_if_quota_consumed: { used_after: 2, limit: 3 },
    asset_created: {
      asset_type: 'gold',
      valuation_mode: 'market_priced',
      auto_price: true,
    },
    asset_updated: { asset_type: 'stock', days_since_last_update: 12 },
    goal_created: { active_count_after: 2, priority: 'high' },
    upcoming_created: {
      direction: 'outgoing',
      recurring: true,
      requirement: 'required',
    },
    trial_started: { days: 14 },
    checkout_created: {
      plan_code: 'premium_yearly',
      price_vnd: 299_000,
      discount_percent: 0,
      from_reason: 'goal_quota',
    },
    payment_settled: {
      plan_code: 'premium_yearly',
      price_vnd: 299_000,
      provider: 'payos',
      store: null,
      from_reason: 'goal_quota',
    },
    subscription_granted: {
      source: 'payment',
      added_days: 365,
      stacked: false,
      noop: false,
      lifetime: false,
    },
    code_redeemed: {
      campaign: 'beta-2026-q1',
      grant_type: 'duration_days',
      added_days: 90,
      lifetime: false,
    },
    subscription_expired: { was_trial: true, plan_source: 'trial' },
    export_run: { format: 'csv', dataset: 'assets' },
  };

  it('has a sample payload for every registered event', () => {
    // Without this, adding an event silently exempts it from every scan below.
    expect(Object.keys(SAMPLE_PAYLOADS).sort()).toEqual(
      [...ANALYTICS_EVENT_NAMES].sort(),
    );
  });

  it('names no property after money or a person', () => {
    for (const [event, props] of Object.entries(SAMPLE_PAYLOADS)) {
      for (const key of Object.keys(props)) {
        if (ALLOWED_PROPERTY_EXCEPTIONS.includes(key)) continue;

        const offending = BANNED_PROPERTY_FRAGMENTS.find((fragment) =>
          key.toLowerCase().includes(fragment),
        );
        expect(`${event}.${key} → ${offending ?? 'ok'}`).toBe(
          `${event}.${key} → ok`,
        );
      }
    }
  });

  /**
   * A household figure in VND is always at least a thousand; a count, a day
   * span or an index never is. So an unexpectedly large number is the signature
   * of a real balance that slipped through under an innocent name.
   */
  it('carries no figure large enough to be a household amount', () => {
    for (const [event, props] of Object.entries(SAMPLE_PAYLOADS)) {
      for (const [key, value] of Object.entries(props)) {
        if (key === 'price_vnd') continue;
        if (typeof value !== 'number') continue;

        expect(`${event}.${key}=${value}`).toBe(
          value < 1000 ? `${event}.${key}=${value}` : `${event}.${key}=<1000`,
        );
      }
    }
  });

  it('bans every key the logger already redacts', () => {
    // The two lists must never disagree about `token` or `password`.
    for (const sensitive of SENSITIVE_KEYS) {
      const covered = BANNED_PROPERTY_FRAGMENTS.some((fragment) =>
        sensitive.includes(fragment),
      );
      const isCredential = /token|password|secret|key|cookie|authorization/.test(
        sensitive,
      );
      expect(covered || isCredential).toBe(true);
    }
  });

  it('allows only a bucket label and our own list price', () => {
    expect([...ALLOWED_PROPERTY_EXCEPTIONS].sort()).toEqual([
      'amount_bucket',
      'price_vnd',
    ]);
  });

  it('still bans a raw figure even though `price` is not a fragment', () => {
    const banned = (key: string) =>
      BANNED_PROPERTY_FRAGMENTS.some((fragment) =>
        key.toLowerCase().includes(fragment),
      );

    expect(banned('goal_amount')).toBe(true);
    expect(banned('lowest_balance')).toBe(true);
    expect(banned('asset_value')).toBe(true);
    // Matched by `vnd` — it reaches the catalog only via the explicit
    // exception, never by the fragment list going soft.
    expect(banned('price_vnd')).toBe(true);
    // The boolean feature flag the `price` fragment used to trip on.
    expect(banned('auto_price')).toBe(false);
  });

  it('keeps the paywall reasons the 402 body can actually carry', () => {
    // Eight. `trial_ending` and `manage` are client entries — nothing refused
    // them, so no 402 exists to carry them.
    expect(PAYWALL_REASONS).toHaveLength(8);
    expect(isPaywallReason('goal_quota')).toBe(true);
    expect(isPaywallReason('trial_ending')).toBe(false);
    expect(isPaywallReason('manage')).toBe(false);
  });
});

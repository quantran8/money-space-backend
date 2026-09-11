/**
 * Every product event, and the only place one may be declared.
 *
 * Two rules this file exists to enforce, both mechanical rather than
 * remembered:
 *
 * 1. **No household figure ever leaves the server.** `SafeProps` deletes any
 *    property whose name looks like money or a person, so a banned name is a
 *    compile error at the CALL SITE, not a review comment. See [[analytics]].
 * 2. **One vocabulary across backend, web and mobile.** This file is copied to
 *    `packages/core` by `pnpm analytics:sync`; `--check` fails CI on drift.
 *
 * It is deliberately DEPENDENCY-FREE — no Nest, no Prisma, no imports at all —
 * because it has to stay copyable into a React Native bundle.
 */

/* ────────────────────────────── the ban ────────────────────────────── */

/**
 * Name fragments that may never carry a value. Matched case-insensitively
 * anywhere in the property name.
 */
type BannedFragment =
  | 'amount'
  | 'balance'
  | 'value'
  | 'total'
  | 'vnd'
  | 'sum'
  | 'email'
  | 'name'
  | 'phone'
  | 'address'
  | 'note'
  | 'label'
  | 'title'
  | 'description';

/**
 * Two exceptions, each carved out of a fragment that is otherwise pulling its
 * weight:
 *
 * - `amount_bucket` — a bucket LABEL (`'10-50M'`), never a figure. Named this
 *   way so `amount` keeps catching everything else.
 * - `price_vnd` — OUR list price from `PLAN_CATALOG`. It is revenue, not the
 *   household's money. Caught by `vnd`, which stays: every real money property
 *   in this codebase is integer VND, so `vnd` is the strongest signal there is.
 *
 * `price` itself is deliberately NOT a fragment. It caught only `auto_price`,
 * a boolean feature flag whose name mirrors `autoPriceEnabled` and
 * `auto_price_quota` — and a rule that fires only on false positives is the
 * kind that gets switched off.
 */
type AllowedException = 'amount_bucket' | 'price_vnd';

type AllowedKey<K extends string> = K extends AllowedException
  ? K
  : Lowercase<K> extends `${string}${BannedFragment}${string}`
    ? never
    : K;

/**
 * Drops every banned key from a props type. A property named `amount` simply
 * ceases to exist, so passing one fails to typecheck where it is written.
 */
export type SafeProps<T> = {
  [K in keyof T & string as AllowedKey<K>]: T[K];
};

/* ───────────────────────────── vocabulary ──────────────────────────── */

/** Mirrors `common/analytics/paywall-reason.ts`. Inlined to keep this file free of imports. */
export type PaywallReasonName =
  | 'goal_quota'
  | 'whatif_quota'
  | 'auto_price_quota'
  | 'forecast_horizon'
  | 'history'
  | 'export'
  | 'expired'
  | 'general';

/**
 * Every way the paywall can open, including the two the CLIENT opens with
 * nothing refused (`trial_ending`, `manage`). A 402 can only ever carry a
 * `PaywallReasonName`; this superset is what analytics counts.
 */
export type PaywallEntryName = PaywallReasonName | 'trial_ending' | 'manage';

/** Mirrors `forecast/domain/what-if.ts`. `watch` went with the protected reserve. */
export type WhatIfResultName = 'comfortable' | 'tight' | 'not_covered';

/** Where the household opened what-if from. `other` is the honest fallback. */
export type WhatIfSourceName =
  | 'home'
  | 'upcoming'
  | 'goal'
  | 'goal-detail'
  | 'other';

/** Mirrors `EntitlementSource` in the Prisma schema. */
export type GrantSourceName =
  | 'redeem_code'
  | 'payment'
  | 'manual_grant'
  | 'trial';

export type PaymentProviderName = 'payos' | 'revenuecat';

export type PlanCodeName =
  | 'premium_monthly'
  | 'premium_yearly'
  | 'premium_lifetime';

export type ExportFormatName = 'json' | 'csv';

export type ExportDatasetName =
  | 'assets'
  | 'money-events'
  | 'cashflow-events'
  | 'goals'
  | 'debts';

/* ────────────────────────────── the events ─────────────────────────── */

/**
 * The catalog. Every value is wrapped in `SafeProps`, so adding a money-shaped
 * property here makes the emit call stop compiling.
 */
export interface AnalyticsEventMap {
  /* ── client only ── */
  /**
   * Emitted by the clients, never the server. Declared here anyway: the catalog
   * is the shared vocabulary, and an event only one side knows about is exactly
   * the drift this file exists to prevent.
   */
  app_opened: SafeProps<{
    platform: 'web' | 'ios' | 'android';
    /** `null` on a first-ever open — better than a fabricated number. */
    minutes_since_last_open: number | null;
  }>;
  /** Every route in: the optimistic gate, the 402 handler, an upgrade button. */
  paywall_shown: SafeProps<{
    reason: PaywallEntryName;
    limit: number | null;
    used: number | null;
  }>;
  signed_out: SafeProps<Record<string, never>>;

  /* ── household lifecycle ── */
  household_created: SafeProps<{
    update_frequency: string;
    /**
     * Whether a partner was invited in the same step. A boolean — the address
     * itself never leaves the server, which is why this is not named for it.
     */
    partner_invited: boolean;
  }>;
  member_joined: SafeProps<{
    method: 'invite' | 'join_link';
    /**
     * 2 for the second person — the activation number the product turns on.
     * `null` where the accept path does not load the member list; the SQL
     * report answers the same question exactly, so it is left honest rather
     * than derived from a second query on the join path.
     */
    member_index: number | null;
    hours_since_household_created: number | null;
    /** The join that changed nothing: they were already a member. */
    already_member: boolean;
  }>;

  /* ── the walls ── */
  paywall_hit: SafeProps<{
    reason: PaywallReasonName;
    tier: 'free' | 'premium';
    /** The ceiling, when the wall was a counted one. */
    limit: number | null;
    used: number | null;
    household_age_days: number | null;
  }>;
  /**
   * The SILENT wall: an auto-priced asset over the ceiling is created anyway,
   * with automation off. It never throws, so nothing else can see it.
   */
  auto_price_declined: SafeProps<{
    reason: PaywallReasonName;
    asset_type: string;
    limit: number | null;
    used: number | null;
  }>;

  /* ── what-if ── */
  what_if_run: SafeProps<{
    source: WhatIfSourceName;
    /** Exploring the answer on screen, not a new question. Filter these out. */
    rerun: boolean;
    has_goal: boolean;
    has_asset_sale: boolean;
    /** A BUCKET, never the figure. See `amountBucket()`. */
    amount_bucket: string;
    result_type: WhatIfResultName;
  }>;
  what_if_quota_consumed: SafeProps<{
    used_after: number;
    limit: number;
  }>;

  /* ── records ── */
  asset_created: SafeProps<{
    asset_type: string;
    valuation_mode: string;
    /** `null` when the type has no market price to fetch. */
    auto_price: boolean | null;
  }>;
  asset_updated: SafeProps<{
    asset_type: string;
    days_since_last_update: number;
  }>;
  goal_created: SafeProps<{
    active_count_after: number;
    priority: string;
  }>;
  upcoming_created: SafeProps<{
    direction: 'incoming' | 'outgoing';
    recurring: boolean;
    requirement: string | null;
  }>;

  /* ── money ── */
  trial_started: SafeProps<{ days: number }>;
  checkout_created: SafeProps<{
    plan_code: PlanCodeName;
    price_vnd: number;
    discount_percent: number;
    /** Which wall sent them here. `null` = opened from the plans page. */
    from_reason: PaywallReasonName | null;
  }>;
  payment_settled: SafeProps<{
    plan_code: string;
    /**
     * What WE charged, in đồng — exact on the PayOS rail, where the order row
     * froze it.
     *
     * `null` on the store rail: RevenueCat reports
     * `price_in_purchased_currency`, which is whatever the store charged in
     * whatever currency, and calling that `_vnd` would mislabel a foreign
     * figure as đồng and corrupt any sum across both rails. Store revenue is
     * reconciled in the store console. See [[analytics]].
     */
    price_vnd: number | null;
    provider: PaymentProviderName;
    store: string | null;
    from_reason: PaywallReasonName | null;
  }>;
  subscription_granted: SafeProps<{
    source: GrantSourceName;
    added_days: number | null;
    /** Stacked onto a period that had not run out yet. */
    stacked: boolean;
    /** The grant changed nothing — a lifetime household, or a stale date. */
    noop: boolean;
    lifetime: boolean;
  }>;
  code_redeemed: SafeProps<{
    campaign: string;
    grant_type: 'duration_days' | 'until_date' | 'lifetime';
    added_days: number | null;
    lifetime: boolean;
  }>;
  subscription_expired: SafeProps<{
    was_trial: boolean;
    plan_source: GrantSourceName | null;
  }>;

  /* ── data out ── */
  export_run: SafeProps<{
    format: ExportFormatName;
    dataset: ExportDatasetName | null;
  }>;
}

export type AnalyticsEventName = keyof AnalyticsEventMap;

/**
 * Every event name at runtime — what the drift check and the property-ban spec
 * iterate over. Keep in the same order as the interface.
 */
export const ANALYTICS_EVENT_NAMES: readonly AnalyticsEventName[] = [
  'app_opened',
  'paywall_shown',
  'signed_out',
  'household_created',
  'member_joined',
  'paywall_hit',
  'auto_price_declined',
  'what_if_run',
  'what_if_quota_consumed',
  'asset_created',
  'asset_updated',
  'goal_created',
  'upcoming_created',
  'trial_started',
  'checkout_created',
  'payment_settled',
  'subscription_granted',
  'code_redeemed',
  'subscription_expired',
  'export_run',
] as const;

/**
 * The banned fragments again, at runtime, for the spec that scans example
 * payloads. The type above cannot check a VALUE — this is what catches a real
 * balance hiding under a blandly-named key.
 */
export const BANNED_PROPERTY_FRAGMENTS: readonly string[] = [
  'amount',
  'balance',
  'value',
  'total',
  'vnd',
  'sum',
  'email',
  'name',
  'phone',
  'address',
  'note',
  'label',
  'title',
  'description',
] as const;

export const ALLOWED_PROPERTY_EXCEPTIONS: readonly string[] = [
  'amount_bucket',
  'price_vnd',
] as const;

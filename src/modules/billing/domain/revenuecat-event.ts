/** RevenueCat's webhook body, narrowed to the fields we actually read. */
export interface RevenuecatEvent {
  /** e.g. INITIAL_PURCHASE, RENEWAL. See `GRANTING_EVENTS`. */
  type?: string;
  /** Our `app_user_id`. Set to the profile id at login. */
  app_user_id?: string;
  /** Every id this subscriber has been known by, after an alias. */
  aliases?: string[];
  original_app_user_id?: string;
  /** The store product, e.g. `oursight_premium_yearly`. */
  product_id?: string;
  /** RevenueCat's entitlement ids this event affects. */
  entitlement_ids?: string[] | null;
  /** APP_STORE | PLAY_STORE | STRIPE | ... */
  store?: string;
  environment?: string;
  /** Unique per transaction. Our idempotency key. */
  transaction_id?: string;
  original_transaction_id?: string;
  /** Milliseconds since epoch. */
  purchased_at_ms?: number;
  expiration_at_ms?: number | null;
  event_timestamp_ms?: number;
  /** Present on a purchase; absent on a cancellation. */
  price?: number;
  price_in_purchased_currency?: number;
  currency?: string;
  /** True while the store subscription is in a free trial. */
  period_type?: string;
  /** Set by us at purchase time so a renewal can still name the household. */
  subscriber_attributes?: Record<string, { value?: string }> | null;
}

export interface RevenuecatWebhookBody {
  api_version?: string;
  event?: RevenuecatEvent;
}

/**
 * The events that hand a household time. **An IAP only ever ADDS time** —
 * CANCELLATION and EXPIRATION are deliberately absent. See
 * `memory/billing-and-entitlement.md`.
 */
export const GRANTING_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'NON_RENEWING_PURCHASE',
  'UNCANCELLATION',
  // A subscription moved between products. It carries the new product and a
  // new expiry, so it grants exactly like a renewal.
  'PRODUCT_CHANGE',
]);

/** Money came BACK out. Logged, never acted on automatically. */
export const REVOCATION_EVENTS = new Set(['REFUND', 'REVOKE', 'CHARGEBACK']);

/** Which store took the money, in our own enum's terms. */
export function purchaseStoreOf(store: string | undefined): 'app_store' | 'play_store' | null {
  if (store === 'APP_STORE') return 'app_store';
  if (store === 'PLAY_STORE') return 'play_store';
  return null;
}

/** Every id this subscriber may be known by — an alias arrives with both. */
export function subscriberIdsOf(event: RevenuecatEvent): string[] {
  const ids = [
    event.app_user_id,
    ...(event.aliases ?? []),
    event.original_app_user_id,
  ].filter((id): id is string => Boolean(id));

  return [...new Set(ids)];
}

/**
 * The idempotency key. Per-charge: `original_transaction_id` is shared by every
 * renewal, so keying on it would make year two look like a replay of year one.
 */
export function transactionKeyOf(event: RevenuecatEvent): string | null {
  return event.transaction_id ?? event.original_transaction_id ?? null;
}

import {
  GRANTING_EVENTS,
  REVOCATION_EVENTS,
  purchaseStoreOf,
  subscriberIdsOf,
  transactionKeyOf,
} from './revenuecat-event';

describe('RevenueCat events', () => {
  describe('which events grant time', () => {
    it('grants on a purchase and on a renewal', () => {
      expect(GRANTING_EVENTS.has('INITIAL_PURCHASE')).toBe(true);
      expect(GRANTING_EVENTS.has('RENEWAL')).toBe(true);
      expect(GRANTING_EVENTS.has('NON_RENEWING_PURCHASE')).toBe(true);
      expect(GRANTING_EVENTS.has('PRODUCT_CHANGE')).toBe(true);
    });

    /**
     * The invariant worth protecting: cancelling turns auto-renew off, it does
     * not end access. Acting on it would take away days that were paid for.
     */
    it('does NOT act on cancellation or expiration', () => {
      expect(GRANTING_EVENTS.has('CANCELLATION')).toBe(false);
      expect(GRANTING_EVENTS.has('EXPIRATION')).toBe(false);
      expect(REVOCATION_EVENTS.has('CANCELLATION')).toBe(false);
    });

    it('treats a refund as something a person reviews, not a grant', () => {
      expect(REVOCATION_EVENTS.has('REFUND')).toBe(true);
      expect(GRANTING_EVENTS.has('REFUND')).toBe(false);
    });
  });

  describe('the transaction key', () => {
    /**
     * Keying on `original_transaction_id` would make the second year's renewal
     * look like a replay of the first and silently grant nothing.
     */
    it('prefers transaction_id so each renewal is its own charge', () => {
      expect(
        transactionKeyOf({
          transaction_id: 'txn_2',
          original_transaction_id: 'txn_1',
        }),
      ).toBe('txn_2');
    });

    it('falls back to the original id when there is no per-charge one', () => {
      expect(transactionKeyOf({ original_transaction_id: 'txn_1' })).toBe('txn_1');
    });

    it('is null when the event carries neither', () => {
      expect(transactionKeyOf({})).toBeNull();
    });
  });

  describe('subscriber ids', () => {
    /** An anonymous purchase aliased to an account arrives under both ids. */
    it('collects every id the subscriber is known by, without duplicates', () => {
      expect(
        subscriberIdsOf({
          app_user_id: 'user_a',
          aliases: ['user_a', 'anon_b'],
          original_app_user_id: 'anon_b',
        }),
      ).toEqual(['user_a', 'anon_b']);
    });

    it('is empty when nothing identifies the subscriber', () => {
      expect(subscriberIdsOf({})).toEqual([]);
    });
  });

  describe('the store', () => {
    it('maps the two stores we sell on', () => {
      expect(purchaseStoreOf('APP_STORE')).toBe('app_store');
      expect(purchaseStoreOf('PLAY_STORE')).toBe('play_store');
    });

    it('is null for a store we do not record', () => {
      expect(purchaseStoreOf('STRIPE')).toBeNull();
      expect(purchaseStoreOf(undefined)).toBeNull();
    });
  });
});

/**
 * PayOS's order reference.
 *
 * It must be an **integer**, unique per merchant — which is why the
 * `orderRef = "OSK4M2QX7T"` string this design originally carried could not be
 * used at all.
 *
 * `(epochSeconds % 100_000_000) * 100 + random(0..99)`:
 *
 * - the seconds keep it roughly ordered by time, which makes an order findable
 *   in PayOS's dashboard by eye;
 * - `% 100_000_000` keeps it inside PayOS's accepted range (it rolls over
 *   about every 3 years, and the unique index is what settles a collision
 *   then);
 * - the two random digits give 100 slots per second, so two checkouts started
 *   in the same second are unlikely to collide rather than certain to.
 *
 * "Unlikely" is deliberate and sufficient: the UNIQUE index on `order_code` is
 * what actually decides it. A collision fails the insert and the caller
 * generates another — a retry, not a lost payment.
 */
export function generateOrderCode(now = new Date()): number {
  const seconds = Math.floor(now.getTime() / 1000) % 100_000_000;
  const salt = Math.floor(Math.random() * 100);
  return seconds * 100 + salt;
}

/**
 * PayOS caps `description` at **9 characters** for bank accounts not linked to
 * PayOS, so it is a constant rather than anything per-order.
 *
 * Nothing is lost by that: the household scans a QR on PayOS's hosted page, so
 * nobody ever types a transfer memo — which is exactly the free-text matching
 * that made the Casso approach fragile. `orderCode` carries the identity.
 */
export const PAYMENT_DESCRIPTION = 'OURSIGHT';

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Verify a webhook came from RevenueCat. It sends a shared secret rather than
 * signing the body, so this proves the caller knows the secret — NOT that the
 * body is unaltered. Hashed first so a length mismatch cannot throw or leak.
 */
export function verifyWebhookAuth(
  header: string | undefined,
  secret: string,
): boolean {
  // An unset secret must never mean "everything authenticates".
  if (!secret) return false;
  if (!header) return false;

  const digest = (value: string) => createHash('sha256').update(value).digest();

  return timingSafeEqual(digest(header), digest(secret));
}
